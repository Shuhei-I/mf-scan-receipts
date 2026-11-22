import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import iconv from 'iconv-lite';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'data');
mkdirSync(dataDir, { recursive: true });
function loadLocalEnv() {
  const envPath = path.join(here, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadLocalEnv();
const journalTemplatePath = path.join(here, 'docs', 'csv-templates', 'journal_sample.csv');
const accountListPath = path.join(here, 'docs', 'account-item-template', 'indiv_items_download.csv');
const businessOperatorDir = path.join(here, 'docs', 'business-operator-template');
const receiptRoot = path.resolve(process.env.RECEIPTS_ROOT || path.join(here, 'receipts'));
let port = Number(process.env.PORT || 4174);
const credentialScript = path.join(here, 'scripts', 'credential.ps1');
const db = new DatabaseSync(path.join(dataDir, 'receipts.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    extension TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    transaction_date TEXT NOT NULL DEFAULT '',
    payee TEXT NOT NULL DEFAULT '',
    total_amount INTEGER,
    expense_amount INTEGER,
    tax_amount INTEGER,
    registration_number TEXT NOT NULL DEFAULT '',
    business_operator_code TEXT NOT NULL DEFAULT '',
    account_name TEXT NOT NULL DEFAULT '',
    payment_name TEXT NOT NULL DEFAULT '',
    memo TEXT NOT NULL DEFAULT '',
    ocr_status TEXT NOT NULL DEFAULT 'not_started',
    ocr_candidates_json TEXT NOT NULL DEFAULT '',
    ocr_error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS files_status_idx ON files(status);
  CREATE INDEX IF NOT EXISTS files_hash_idx ON files(sha256);
  CREATE TABLE IF NOT EXISTS ocr_jobs (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(id),
    status TEXT NOT NULL DEFAULT 'waiting',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ocr_jobs_status_idx ON ocr_jobs(status, created_at);
`);
for (const [name, definition] of [['ocr_status', "TEXT NOT NULL DEFAULT 'not_started'"], ['ocr_candidates_json', "TEXT NOT NULL DEFAULT ''"], ['ocr_error', "TEXT NOT NULL DEFAULT ''"], ['business_operator_code', "TEXT NOT NULL DEFAULT ''"]]) {
  try { db.exec(`ALTER TABLE files ADD COLUMN ${name} ${definition}`); } catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
}

const allowedExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.pdf', '.heic']);
const ignoredDirectories = new Set(['整理済み', '.git', 'node_modules', 'data']);

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}
function loadExpenseAccounts() {
  if (!existsSync(accountListPath)) return [];
  try {
    const rows = parseCsv(iconv.decode(readFileSync(accountListPath), 'cp932'));
    const headers = rows.shift() || [];
    const index = Object.fromEntries(headers.map((name, i) => [name.replace(/^\uFEFF/, ''), i]));
    const active = new Map();
    for (const row of rows) {
      const statement = row[index['帳票']] || '';
      const account = (row[index['勘定科目']] || '').trim();
      const enabled = row[index['使用']] || '';
      if (statement !== '損益計算書' || !account || enabled !== '1') continue;
      const taxCategory = (row[index['税区分']] || '').trim();
      const prior = active.get(account);
      active.set(account, { name: account, taxCategory: prior?.taxCategory || taxCategory });
    }
    return [...active.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  } catch (error) {
    console.error('勘定科目CSVを読み込めません:', error.message);
    return [];
  }
}
const expenseAccounts = loadExpenseAccounts();
const expenseAccountByName = new Map(expenseAccounts.map(account => [account.name, account]));
function loadBusinessOperators() {
  try {
    const filename = readdirSync(businessOperatorDir)
      .filter(name => /^business_operator_\d{8}_\d{4}\.csv$/i.test(name))
      .sort()
      .at(-1);
    if (!filename) return { filename: '', records: [] };
    const rows = parseCsv(iconv.decode(readFileSync(path.join(businessOperatorDir, filename)), 'cp932'));
    const headers = rows.shift() || [];
    const index = Object.fromEntries(headers.map((name, i) => [name.replace(/^\uFEFF/, ''), i]));
    for (const required of ['コード','取引先名','検索キー','表示設定','登録番号','法人番号']) {
      if (!Object.hasOwn(index, required)) throw new Error(`必須列「${required}」がありません`);
    }
    const records = rows.map(row => ({
      code: (row[index['コード']] || '').trim(),
      name: (row[index['取引先名']] || '').trim(),
      searchKey: (row[index['検索キー']] || '').trim(),
      displaySetting: (row[index['表示設定']] || '').trim(),
      registrationNumber: (row[index['登録番号']] || '').trim(),
      corporateNumber: (row[index['法人番号']] || '').trim()
    })).filter(record => record.code && record.name && record.displaySetting !== '0');
    return { filename, records };
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('取引先マスタCSVを読み込めません:', error.message);
    return { filename: '', records: [] };
  }
}
const businessOperatorMaster = loadBusinessOperators();
const businessOperators = businessOperatorMaster.records;
const businessOperatorByCode = new Map(businessOperators.map(operator => [operator.code, operator]));
function operatorSummary(operator) {
  return { code: operator.code, name: operator.name, registrationNumber: operator.registrationNumber };
}
function normalizePartnerName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/[\s\u3000・･,，.．。:：;；()（）［］【】\-‐‑‒–—_]/g, '');
}
function normalizeRegistrationNumber(value) {
  return String(value || '').normalize('NFKC').toUpperCase().replace(/[\s\u3000\-‐‑‒–—]/g, '');
}
function partnerNameScore(left, right) {
  if (!left || !right) return 0;
  const a = [...left], b = [...right];
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(current[j-1] + 1, previous[j] + 1, previous[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}
function matchBusinessOperator(payee, registrationNumber) {
  const reg = normalizeRegistrationNumber(registrationNumber);
  const name = normalizePartnerName(payee);
  if (reg) {
    const byRegistration = businessOperators.filter(operator => normalizeRegistrationNumber(operator.registrationNumber) === reg);
    if (byRegistration.length === 1) return { status: 'matched', matchType: '登録番号', operator: operatorSummary(byRegistration[0]), candidates: [] };
    if (byRegistration.length > 1) return { status: 'suggested', matchType: '登録番号が重複', operator: null, candidates: byRegistration.slice(0, 3).map(operatorSummary) };
  }
  if (name) {
    const byName = businessOperators.filter(operator => [operator.name, operator.searchKey].some(value => value && normalizePartnerName(value) === name));
    if (byName.length === 1) {
      const operator = byName[0];
      const conflict = reg && normalizeRegistrationNumber(operator.registrationNumber) && normalizeRegistrationNumber(operator.registrationNumber) !== reg;
      if (!conflict) return { status: 'matched', matchType: operator.searchKey && normalizePartnerName(operator.searchKey) === name ? '検索キー' : '取引先名', operator: operatorSummary(operator), candidates: [] };
      return { status: 'suggested', matchType: '取引先名一致・登録番号不一致', operator: null, candidates: [operatorSummary(operator)] };
    }
    if (byName.length > 1) return { status: 'suggested', matchType: '名称が重複', operator: null, candidates: byName.slice(0, 3).map(operatorSummary) };
    const ranked = businessOperators.map(operator => ({ operator, score: Math.max(partnerNameScore(name, normalizePartnerName(operator.name)), partnerNameScore(name, normalizePartnerName(operator.searchKey))) }))
      .filter(item => item.score >= (name.length <= 5 ? 0.8 : 0.7))
      .sort((a, b) => b.score - a.score || a.operator.name.localeCompare(b.operator.name, 'ja'))
      .slice(0, 3);
    if (ranked.length) return { status: 'suggested', matchType: '名称の類似候補', operator: null, candidates: ranked.map(item => ({ ...operatorSummary(item.operator), score: item.score })) };
  }
  return { status: 'unmatched', matchType: '', operator: null, candidates: [] };
}
const journalHeaders = (() => {
  if (!existsSync(journalTemplatePath)) return [];
  try { return (parseCsv(iconv.decode(readFileSync(journalTemplatePath), 'cp932'))[0] || []).map(value => value.replace(/^\uFEFF/, '')); }
  catch (error) { console.error('仕訳テンプレートを読み込めません:', error.message); return []; }
})();

function scanFiles() {
  if (!existsSync(receiptRoot)) return { found: 0, added: 0, changed: 0, missingRoot: true };
  let found = 0, added = 0, changed = 0;
  const seen = new Set();
  const upsert = db.prepare(`INSERT INTO files
    (id, source_path, filename, extension, size, mtime, sha256, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      filename=excluded.filename, extension=excluded.extension, size=excluded.size,
      mtime=excluded.mtime, sha256=excluded.sha256, updated_at=excluded.updated_at
    WHERE files.size != excluded.size OR files.mtime != excluded.mtime OR files.sha256 != excluded.sha256`);
  const existing = db.prepare('SELECT id, size, mtime, sha256 FROM files WHERE source_path=?');
  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(ext)) continue;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      found++;
      const relative = path.relative(receiptRoot, full);
      const prior = existing.get(relative);
      const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
      const id = prior?.id || randomUUID();
      upsert.run(id, relative, entry.name, ext, stat.size, stat.mtimeMs, hash, new Date().toISOString());
      if (!prior) added++;
      else if (prior.size !== stat.size || prior.mtime !== stat.mtimeMs || prior.sha256 !== hash) changed++;
      seen.add(relative);
    }
  }
  walk(receiptRoot);
  return { found, added, changed, missingRoot: false };
}

function allFiles() {
  return db.prepare(`SELECT id, filename, extension, size, status, transaction_date, payee,
    total_amount, expense_amount, tax_amount, registration_number, business_operator_code, account_name, payment_name, memo,
    ocr_status, ocr_candidates_json, ocr_error, sha256, source_path FROM files ORDER BY filename COLLATE NOCASE`).all();
}
function safeSource(row) {
  const full = path.resolve(receiptRoot, row.source_path);
  if (!full.startsWith(receiptRoot + path.sep) || !existsSync(full)) return null;
  return full;
}
function archiveTarget(row, input) {
  const date = String(input.transaction_date || row.transaction_date || '');
  const payee = String(input.payee ?? row.payee ?? '');
  const amount = input.expense_amount ?? row.expense_amount ?? row.total_amount;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !payee || amount === null || amount === '' || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return null;
  const safePayee = payee.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 60) || '取引先不明';
  const idShort = row.id.replaceAll('-', '').slice(0, 8);
  const name = `${date.replaceAll('-', '')}_${Number(amount)}_${safePayee}_${idShort}${row.extension}`;
  const directory = path.join(receiptRoot, '整理済み', date.slice(0, 4), date.slice(0, 7));
  return { name, directory, fullPath: path.join(directory, name) };
}
function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(payload) : payload);
}
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 100_000) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function credential(action, stdinText = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',credentialScript,action], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) { resolve(stdout.trim()); return; }
      if (stderr.includes('1312')) {
        reject(new Error('Windows資格情報マネージャーを利用できないログオンセッションです。このアプリを start-app.cmd からデスクトップ上で起動してください。'));
        return;
      }
      reject(new Error(stderr.trim() || 'Windows資格情報の操作に失敗しました'));
    });
    child.stdin.end(stdinText, 'utf8');
  });
}
async function getApiKey() {
  const encoded = await credential('get');
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : '';
}
const jobWorkers = { active: 0, max: 2 };
const receiptSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    transaction_date: { type: ['string','null'], description: '取引日をYYYY-MM-DD。判読できなければnull' },
    payee: { type: ['string','null'], description: '店名または取引先名。判読できなければnull' },
    total_amount: { type: ['integer','null'], description: '証憑に記載された税込合計金額（円）。不明ならnull' },
    tax_amount: { type: ['integer','null'], description: '証憑から読み取れる税額（円）。記載がなければnull' },
    registration_number: { type: ['string','null'], description: '適格請求書発行事業者の登録番号。記載がなければnull' },
    account_name: { type: ['string','null'], description: '購入内容から推測した勘定科目。候補一覧から完全一致で1つ選び、判断できなければnull' },
    memo: { type: ['string','null'], description: '証憑に読み取れる品目や利用目的を短くまとめた仕訳摘要。支払先だけでなく内容が読めれば含める。推測で事実を追加しない' }
  }, required: ['transaction_date','payee','total_amount','tax_amount','registration_number','account_name','memo']
};
async function callReceiptOcr(file, apiKey) {
  const full = safeSource(file);
  if (!full) throw Object.assign(new Error('原本ファイルが見つかりません'), { retryable: false });
  const stat = statSync(full);
  if (stat.size > 20 * 1024 * 1024) throw Object.assign(new Error('20 MBを超えるファイルはこの版では読み取れません'), { retryable: false });
  const bytes = readFileSync(full);
  let documentPart;
  if (file.extension === '.pdf') {
    documentPart = { type: 'input_file', filename: file.filename, file_data: `data:application/pdf;base64,${bytes.toString('base64')}`, detail: 'high' };
  } else {
    const mime = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp' }[file.extension];
    if (!mime) throw Object.assign(new Error('OCR対応形式はPDF、JPG、PNG、WEBPです。原本形式は維持されます'), { retryable: false });
    documentPart = { type: 'input_image', image_url: `data:${mime};base64,${bytes.toString('base64')}`, detail: 'high' };
  }
  const accountNames = expenseAccounts.map(account => account.name);
  const body = {
    model: 'gpt-6-luna', store: false, max_output_tokens: 500,
    input: [{ role: 'user', content: [
      { type: 'input_text', text: `あなたは日本の経理証憑を読み取ります。日付・支払先・金額・登録番号は証憑に明記された値を転記し、推測で補完しないでください。取引日はYYYY-MM-DD、金額は円の整数にしてください。読めない値はnullにしてください。登録番号はTから始まる番号が明記されている場合だけ返してください。証憑の品目や内容から、勘定科目候補一覧の中で最も適切なものを完全一致で1つ選んでください。判断できない場合や一覧に合う科目がない場合はnullにしてください。摘要は読み取れる品目・用途を短く記載し、判別できない場合は支払先名を使ってください。勘定科目候補: ${accountNames.join('、') || 'なし'}` },
      documentPart
    ] }],
    text: { format: { type: 'json_schema', name: 'receipt_fields', strict: true, schema: receiptSchema } }
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', { method:'POST', signal:controller.signal, headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result?.error?.message || `OpenAI APIエラー (${response.status})`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    }
    const outputText = result.output_text || result.output?.flatMap(item => item.content || []).find(part => part.type === 'output_text')?.text;
    if (!outputText) throw Object.assign(new Error('AIから読み取り結果が返りませんでした'), { retryable: false });
    const candidate = JSON.parse(outputText);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw Object.assign(new Error('AIの読み取り結果を解釈できませんでした'), { retryable: false });
    return candidate;
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('読み取りが90秒でタイムアウトしました'), { retryable: true });
    throw error;
  } finally { clearTimeout(timeout); }
}
function queueNext() {
  while (jobWorkers.active < jobWorkers.max) {
    const job = db.prepare("SELECT * FROM ocr_jobs WHERE status='waiting' ORDER BY created_at LIMIT 1").get();
    if (!job) return;
    jobWorkers.active++;
    processJob(job).catch(error => console.error('OCR worker error:', error.message)).finally(() => { jobWorkers.active--; queueNext(); });
  }
}
async function processJob(job) {
  const stamp = new Date().toISOString();
  const tries = job.attempts + 1;
  db.prepare("UPDATE ocr_jobs SET status='processing', attempts=?, updated_at=? WHERE id=?").run(tries, stamp, job.id);
  db.prepare("UPDATE files SET ocr_status='processing', ocr_error='', updated_at=? WHERE id=?").run(stamp, job.file_id);
  try {
    const apiKey = await getApiKey();
    if (!apiKey) throw Object.assign(new Error('APIキーが設定されていません'), { retryable:false });
    const file = db.prepare('SELECT * FROM files WHERE id=?').get(job.file_id);
    const candidate = await callReceiptOcr(file, apiKey);
    const values = {
      transaction_date: typeof candidate.transaction_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(candidate.transaction_date) ? candidate.transaction_date : null,
      payee: typeof candidate.payee === 'string' ? candidate.payee.trim() : null,
      total_amount: Number.isInteger(candidate.total_amount) && candidate.total_amount >= 0 ? candidate.total_amount : null,
      tax_amount: Number.isInteger(candidate.tax_amount) && candidate.tax_amount >= 0 ? candidate.tax_amount : null,
      registration_number: typeof candidate.registration_number === 'string' ? candidate.registration_number.trim() : null,
      account_name: typeof candidate.account_name === 'string' && expenseAccountByName.has(candidate.account_name.trim()) ? candidate.account_name.trim() : null,
      memo: typeof candidate.memo === 'string' ? candidate.memo.trim() : null,
      suggestion_source: 'ai'
    };
    values.business_operator_match = matchBusinessOperator(values.payee, values.registration_number);
    if (values.payee) {
      const prior = db.prepare(`SELECT account_name FROM files WHERE status='expense' AND payee=? AND account_name<>'' ORDER BY updated_at DESC LIMIT 1`).get(values.payee);
      if (prior && expenseAccountByName.has(prior.account_name)) {
        values.account_name = prior.account_name;
        values.suggestion_source = '履歴';
      }
    }
    const json = JSON.stringify(values);
    db.prepare("UPDATE files SET ocr_status='ready', ocr_candidates_json=?, ocr_error='', updated_at=? WHERE id=?").run(json, new Date().toISOString(), job.file_id);
    db.prepare("UPDATE ocr_jobs SET status='ready', error='', updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
  } catch (error) {
    const retry = Boolean(error.retryable) && tries < 2;
    const message = String(error.message || '読み取りに失敗しました').slice(0, 500);
    db.prepare('UPDATE ocr_jobs SET status=?, error=?, updated_at=? WHERE id=?').run(retry ? 'waiting' : 'failed', message, new Date().toISOString(), job.id);
    db.prepare('UPDATE files SET ocr_status=?, ocr_error=?, updated_at=? WHERE id=?').run(retry ? 'waiting' : 'failed', message, new Date().toISOString(), job.file_id);
    if (retry) await new Promise(resolve => setTimeout(resolve, 2500));
  }
}
db.prepare("UPDATE ocr_jobs SET status='waiting', updated_at=? WHERE status='processing'").run(new Date().toISOString());
function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function exportCsv(month) {
  const fallbackHeaders = ['取引No','取引日','借方勘定科目','借方補助科目','借方部門','借方取引先','借方税区分','借方インボイス','借方金額(円)','借方税額','貸方勘定科目','貸方補助科目','貸方部門','貸方取引先','貸方税区分','貸方インボイス','貸方金額(円)','貸方税額','摘要','仕訳メモ','タグ','MF仕訳タイプ','決算整理仕訳','作成日時','作成者','最終更新日時','最終更新者'];
  const header = journalHeaders.length === 27 ? journalHeaders : fallbackHeaders;
  const rows = db.prepare(`SELECT * FROM files WHERE status='expense' AND transaction_date LIKE ? ORDER BY transaction_date, id`).all(`${month}-%`);
  const lines = [header.map(csvCell).join(',')];
  let no = 0;
  for (const row of rows) {
    no++;
    const date = row.transaction_date.replaceAll('-', '/');
    const amount = Number(row.expense_amount ?? row.total_amount ?? 0);
    const payee = String(row.payee || '').trim();
    const detail = String(row.memo || '').trim();
    const memo = detail && payee && !detail.startsWith(payee) ? `${payee} ${detail}` : detail || payee;
    const taxCategory = expenseAccountByName.get(row.account_name)?.taxCategory || '';
    const linkedOperator = businessOperatorByCode.get(row.business_operator_code) || (() => {
      const match = matchBusinessOperator(row.payee, row.registration_number);
      return match.status === 'matched' ? match.operator : null;
    })();
    const values = {
      '取引No': no, '取引日': date, '借方勘定科目': row.account_name, '借方税区分': taxCategory,
      '借方取引先': linkedOperator?.name || '', '借方金額(円)': amount, '借方税額': 0, '貸方勘定科目': row.payment_name || '現金',
      '貸方税区分': '対象外', '貸方金額(円)': amount, '貸方税額': 0, '摘要': memo
    };
    lines.push(header.map(name => csvCell(values[name] ?? '')).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const missing = !existsSync(receiptRoot);
      const counts = db.prepare("SELECT status, count(*) AS count FROM files GROUP BY status").all();
      const files = allFiles();
      send(res, 200, {
        root: receiptRoot, missingRoot: missing, counts, files, expenseAccounts, accountListAvailable: expenseAccounts.length > 0,
        businessOperators: businessOperators.map(({ code, name, searchKey, registrationNumber }) => ({ code, name, searchKey, registrationNumber })),
        businessOperatorMaster: { filename: businessOperatorMaster.filename, count: businessOperators.length }
      }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const key = await getApiKey();
      send(res, 200, { apiKeyConfigured: Boolean(key), model: 'gpt-6-luna' }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/api-key') {
      const input = await jsonBody(req);
      const key = String(input.apiKey || '').trim();
      if (!key || key.length > 4096) { send(res, 422, { error: 'APIキーを入力してください' }); return; }
      await credential('set', key);
      send(res, 200, { ok: true }); return;
    }
    if (req.method === 'DELETE' && url.pathname === '/api/settings/api-key') {
      await credential('delete');
      send(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/ocr/jobs') {
      const jobs = db.prepare(`SELECT j.id, j.file_id, j.status, j.attempts, j.error, j.created_at, j.updated_at, f.filename
        FROM ocr_jobs j JOIN files f ON f.id=j.file_id ORDER BY j.created_at DESC LIMIT 100`).all();
      send(res, 200, { jobs }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/ocr/jobs') {
      const input = await jsonBody(req);
      const ids = [...new Set(Array.isArray(input.ids) ? input.ids.filter(id => typeof id === 'string') : [])].slice(0, 100);
      if (!ids.length) { send(res, 422, { error: '読み取る証憑を選択してください' }); return; }
      if (!await getApiKey()) { send(res, 409, { error: '先に設定からOpenAI APIキーを登録してください' }); return; }
      const insert = db.prepare("INSERT INTO ocr_jobs (id, file_id, status, created_at, updated_at) VALUES (?, ?, 'waiting', ?, ?)");
      const update = db.prepare("UPDATE files SET ocr_status='waiting', ocr_candidates_json='', ocr_error='', updated_at=? WHERE id=?");
      let added = 0;
      for (const id of ids) {
        const file = db.prepare("SELECT id, status FROM files WHERE id=?").get(id);
        if (!file || file.status !== 'pending') continue;
        const active = db.prepare("SELECT id FROM ocr_jobs WHERE file_id=? AND status IN ('waiting','processing') LIMIT 1").get(id);
        if (active) continue;
        const stamp = new Date().toISOString();
        insert.run(randomUUID(), id, stamp, stamp); update.run(stamp, id); added++;
      }
      queueNext();
      send(res, 202, { queued: added }); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/ocr/retry/')) {
      const jobId = decodeURIComponent(url.pathname.slice('/api/ocr/retry/'.length));
      const job = db.prepare("SELECT * FROM ocr_jobs WHERE id=? AND status='failed'").get(jobId);
      if (!job) { send(res, 404, { error: '再実行できる失敗ジョブがありません' }); return; }
      const stamp = new Date().toISOString();
      db.prepare("UPDATE ocr_jobs SET status='waiting', attempts=0, error='', updated_at=? WHERE id=?").run(stamp, job.id);
      db.prepare("UPDATE files SET ocr_status='waiting', ocr_candidates_json='', ocr_error='', updated_at=? WHERE id=?").run(stamp, job.file_id);
      queueNext();
      send(res, 202, { ok: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      send(res, 200, scanFiles()); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/file/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/file/'.length));
      const row = db.prepare('SELECT * FROM files WHERE id=?').get(id);
      const full = row && safeSource(row);
      if (!full) { send(res, 404, { error: '証憑ファイルが見つかりません' }); return; }
      const types = { '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.pdf':'application/pdf','.tif':'image/tiff','.tiff':'image/tiff','.heic':'image/heic' };
      res.writeHead(200, { 'Content-Type': types[row.extension] || 'application/octet-stream', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store' });
      createReadStream(full).pipe(res); return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/archive-preview')) {
      const id = decodeURIComponent(url.pathname.slice('/api/file/'.length, -'/archive-preview'.length));
      const row = db.prepare('SELECT * FROM files WHERE id=?').get(id);
      if (!row) { send(res, 404, { error: '証憑が見つかりません' }); return; }
      const input = await jsonBody(req);
      const target = archiveTarget(row, input);
      if (!target) { send(res, 422, { error: '取引日・支払先・経費計上額を入力してください' }); return; }
      send(res, 200, { fileName: target.name, destination: target.fullPath, alreadyExists: existsSync(target.fullPath) }); return;
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/file/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/file/'.length));
      const input = await jsonBody(req);
      const allowed = ['status','transaction_date','payee','total_amount','expense_amount','tax_amount','registration_number','business_operator_code','account_name','payment_name','memo'];
      const assignments = allowed.filter(k => Object.hasOwn(input, k));
      if (!assignments.length) { send(res, 400, { error: '更新項目がありません' }); return; }
      const row = db.prepare('SELECT * FROM files WHERE id=?').get(id);
      if (!row) { send(res, 404, { error: '証憑が見つかりません' }); return; }
      if (Object.hasOwn(input, 'business_operator_code') && input.business_operator_code) {
        const operator = businessOperatorByCode.get(String(input.business_operator_code));
        if (!operator) { send(res, 422, { error: '選択した取引先が現在のマスタにありません。マスタを再確認してください' }); return; }
        if (normalizePartnerName(input.payee ?? row.payee) !== normalizePartnerName(operator.name)) {
          send(res, 422, { error: '支払先と選択した取引先名が一致しません。取引先を選び直してください' }); return;
        }
      }
      const status = input.status ?? row.status;
      const date = input.transaction_date ?? row.transaction_date;
      const payee = input.payee ?? row.payee;
      const expense = input.expense_amount ?? row.expense_amount ?? row.total_amount;
      if (status === 'expense' && (!date || !payee || !Number.isFinite(Number(expense)))) {
        send(res, 422, { error: '経費として確定するには、取引日・支払先・経費計上額が必要です' }); return;
      }
      if (status === 'expense') {
        const target = archiveTarget(row, { transaction_date: date, payee, expense_amount: expense });
        if (!target) { send(res, 422, { error: '保管用コピーを作成できる値がありません' }); return; }
        if (!existsSync(target.directory)) mkdirSync(target.directory, { recursive: true });
        const source = safeSource(row);
        if (!source) { send(res, 404, { error: '原本ファイルが見つかりません' }); return; }
        if (!existsSync(target.fullPath)) copyFileSync(source, target.fullPath);
      }
      const sql = `UPDATE files SET ${assignments.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`;
      db.prepare(sql).run(...assignments.map(k => input[k]), new Date().toISOString(), id);
      send(res, 200, { ok: true }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/export.csv') {
      const month = url.searchParams.get('month') || (() => { const d = new Date(); d.setMonth(d.getMonth()-1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
      if (!/^\d{4}-\d{2}$/.test(month)) { send(res, 400, { error: '年月の指定が正しくありません' }); return; }
      const csv = exportCsv(month);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=Shift_JIS', 'Content-Disposition': `attachment; filename="money-forward-journal-${month}.csv"`, 'Cache-Control': 'no-store' });
      res.end(iconv.encode(csv, 'cp932')); return;
    }
    if (req.method === 'GET') {
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      const full = path.resolve(here, 'public', requested);
      if (!full.startsWith(path.resolve(here, 'public') + path.sep) || !existsSync(full) || !statSync(full).isFile()) { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); return; }
      const ext = path.extname(full);
      const mime = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      createReadStream(full).pipe(res); return;
    }
    send(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    send(res, 500, { error: error.message || 'サーバーエラー' });
  }
});

scanFiles();
function listenOn(candidatePort) {
  port = candidatePort;
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && candidatePort < 4190) { listenOn(candidatePort + 1); return; }
    throw error;
  });
  server.listen(candidatePort, '127.0.0.1', () => console.log(`Receipt Review is ready at http://127.0.0.1:${candidatePort}`));
}
listenOn(port);
queueNext();
