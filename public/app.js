const state = { files: [], jobs: [], accounts: [], businessOperators: [], businessOperatorMaster: { filename:'', count:0 }, filter: 'pending', query: '', view: 'inbox', activeId: null, period: '' };
const $ = (selector) => document.querySelector(selector);
const money = value => value == null || value === '' ? '—' : `${new Intl.NumberFormat('ja-JP').format(value)}円`;
const statusNames = { pending:'未確認', expense:'経費対象', excluded:'対象外', duplicate:'重複候補', hidden:'対応済み' };
const jobNames = { waiting:'待機中', processing:'処理中', ready:'完了', failed:'失敗' };
let toastTimer;
let queuePoll;

async function api(url, options) {
  const response = await fetch(url, options);
  const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(result?.error || '処理に失敗しました');
  return result;
}
function showToast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function normalizePartnerName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP').replace(/[\s\u3000・･,，.．。:：;；()（）［］【】\-‐‑‒–—_]/g, '');
}
function normalizeRegistrationNumber(value) {
  return String(value || '').normalize('NFKC').toUpperCase().replace(/[\s\u3000\-‐‑‒–—]/g, '');
}
function exactBusinessOperator(payee, registrationNumber) {
  const reg = normalizeRegistrationNumber(registrationNumber);
  if (reg) {
    const byRegistration = state.businessOperators.filter(operator => normalizeRegistrationNumber(operator.registrationNumber) === reg);
    if (byRegistration.length === 1) return byRegistration[0];
    if (byRegistration.length > 1) return null;
  }
  const name = normalizePartnerName(payee);
  if (!name) return null;
  const matches = state.businessOperators.filter(operator => [operator.name, operator.searchKey].some(value => value && normalizePartnerName(value) === name));
  if (matches.length !== 1) return null;
  const operator = matches[0];
  if (reg && operator.registrationNumber && normalizeRegistrationNumber(operator.registrationNumber) !== reg) return null;
  return operator;
}
function bytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(0)} KB` : `${(n/1048576).toFixed(1)} MB`; }
function visibleFiles() {
  return state.files.filter(file => {
    const matchesFilter = state.filter === 'all' || file.status === state.filter;
    const query = state.query.trim().toLocaleLowerCase();
    return matchesFilter && (!query || `${file.filename} ${file.payee}`.toLocaleLowerCase().includes(query));
  });
}
function render() {
  const counts = Object.fromEntries(['pending','expense','excluded','duplicate','hidden'].map(key => [key, state.files.filter(file => file.status === key).length]));
  $('#stat-pending').textContent = counts.pending + counts.duplicate;
  $('#stat-expense').textContent = counts.expense;
  $('#stat-excluded').textContent = counts.excluded + counts.hidden;
  $('#nav-count').textContent = counts.pending + counts.duplicate;
  $('#tab-pending').textContent = counts.pending + counts.duplicate;
  $('#batch-hint').textContent = state.settings?.apiKeyConfigured ? '選択した証憑だけをOpenAI APIへ送信' : '読み取りを使うには設定からAPIキーを登録';
  const files = visibleFiles();
  $('#file-list').innerHTML = files.map(file => `
    <article class="file-row" data-id="${file.id}">
      <label class="row-check"><input type="checkbox" class="file-check" value="${file.id}" ${file.status !== 'pending' || ['waiting','processing'].includes(file.ocr_status) ? 'disabled' : ''}><span class="sr-only">${escapeHtml(file.filename)}を選択</span></label>
      <button class="file-thumb" data-open="${file.id}" aria-label="証憑を開く">${file.extension === '.pdf' ? '<span class="pdf-icon">PDF</span>' : `<img src="/api/file/${encodeURIComponent(file.id)}" alt="" loading="lazy">`}</button>
      <button class="file-main" data-open="${file.id}"><span class="file-name">${escapeHtml(file.filename)}</span><span class="file-meta">${bytes(file.size)} <i>·</i> ${file.extension.slice(1).toUpperCase()}</span></button>
      <div class="file-payee"><span>${escapeHtml(file.payee || '支払先未確認')}</span><small>${file.transaction_date || '日付未確認'}</small></div>
      <div class="file-total">${money(file.expense_amount ?? file.total_amount)}</div>
      <span class="status-pill ${file.status}"><i></i>${statusNames[file.status] || file.status}</span>
      <span class="ocr-mark ${file.ocr_status}">${file.ocr_status === 'ready' ? 'AI候補' : file.ocr_status === 'processing' || file.ocr_status === 'waiting' ? '読取中' : ''}</span>
    </article>`).join('');
  $('#empty').classList.toggle('hidden', files.length > 0);
  $('#file-list').classList.toggle('hidden', files.length === 0);
  $('#list-count').textContent = `${files.length}件`;
  $('#select-all').checked = false;
  renderJobs(); updateSelected();
  renderExportPanel();
}
function renderJobs() {
  const panel = $('#queue-panel');
  const jobs = state.jobs.slice(0, 12);
  panel.classList.toggle('hidden', jobs.length === 0);
  const processing = state.jobs.filter(job => job.status === 'processing').length;
  const waiting = state.jobs.filter(job => job.status === 'waiting').length;
  const completed = state.jobs.filter(job => job.status === 'ready').length;
  const failed = state.jobs.filter(job => job.status === 'failed').length;
  $('#queue-summary').textContent = `処理中 ${processing} · 待機 ${waiting} · 完了 ${completed} · 失敗 ${failed}`;
  $('#queue-toggle').classList.toggle('has-failures', failed > 0);
  $('#queue-list').innerHTML = jobs.map(job => `<div class="queue-row"><span class="queue-state ${job.status}"><i></i>${jobNames[job.status] || job.status}</span><span class="queue-file">${escapeHtml(job.filename)}</span><span class="queue-error">${escapeHtml(job.error || '')}</span>${job.status === 'failed' ? `<button class="button secondary queue-retry" data-retry="${job.id}">再実行</button>` : ''}</div>`).join('');
}
function updateSelected() {
  const selected = [...document.querySelectorAll('.file-check:checked')];
  $('#read-selected').disabled = selected.length === 0;
  $('#read-selected').innerHTML = selected.length ? `選択した証憑を読み取る <span>${selected.length}</span>` : '選択した証憑を読み取る <span>↗</span>';
}
function updatePeriod() {
  const now = new Date(); const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  state.period = `${previous.getFullYear()}-${String(previous.getMonth()+1).padStart(2,'0')}`;
}
function renderExportPanel() {
  $('#export-panel')?.remove();
  if (state.view !== 'export') return;
  const count = state.files.filter(file => file.status === 'expense' && file.transaction_date?.startsWith(state.period)).length;
  const [year, month] = state.period.split('-');
  $('#file-list').insertAdjacentHTML('beforebegin', `<section class="export-panel" id="export-panel"><div class="export-info"><span class="eyebrow">MONEY FORWARD</span><h3>仕訳CSVを書き出す</h3><div class="export-controls"><label for="export-month">出力する月</label><input id="export-month" type="month" value="${escapeHtml(state.period)}" required><p id="export-count">${year}年${Number(month)}月の経費確定分：${count}件</p></div></div><button type="button" class="button primary" id="export-download" ${count === 0 ? 'disabled' : ''}>CSVをダウンロード ↓</button></section>`);
  $('#export-month').addEventListener('change', event => {
    const monthValue = event.target.value;
    if (!/^\d{4}-\d{2}$/.test(monthValue)) return;
    state.period = monthValue;
    renderExportPanel();
  });
  $('#export-download').addEventListener('click', () => {
    if (count > 0) window.location.href = `/api/export.csv?month=${encodeURIComponent(state.period)}`;
  });
}
async function loadSettings() {
  state.settings = await api('/api/settings');
  $('#api-key-status').innerHTML = state.settings.apiKeyConfigured ? '<span class="status-dot"></span>APIキーを登録済み' : '<span class="status-dot status-off"></span>APIキー未登録';
  $('#model-name').textContent = state.settings.model === 'gpt-6-luna' ? 'GPT-6 Luna' : state.settings.model;
  $('#clear-api-key').disabled = !state.settings.apiKeyConfigured;
  render();
}
async function loadJobs() { const data = await api('/api/ocr/jobs'); state.jobs = data.jobs; renderJobs(); }
function startQueuePolling() {
  clearInterval(queuePoll);
  queuePoll = setInterval(async () => {
    try { await loadJobs(); await loadState(); }
    catch (error) { console.error(error); }
    if (!state.jobs.some(job => ['waiting','processing'].includes(job.status))) clearInterval(queuePoll);
  }, 2500);
}
function candidateBlock(file) {
  if (file.ocr_status !== 'ready' || !file.ocr_candidates_json) return '';
  let c; try { c = JSON.parse(file.ocr_candidates_json); } catch { return ''; }
  const details = [
    ['取引日',c.transaction_date], ['支払先',c.payee], ['合計金額',c.total_amount == null ? null : money(c.total_amount)],
    ['証憑の税額',c.tax_amount == null ? null : money(c.tax_amount)], ['登録番号',c.registration_number],
    ['勘定科目候補',c.account_name], ['摘要候補',c.memo]
  ];
  const partnerMatch = c.business_operator_match || { status:'unmatched', candidates:[] };
  const partnerHtml = partnerMatch.status === 'matched' && partnerMatch.operator
    ? `<div class="operator-match matched"><b>取引先マスタ一致</b><span>${escapeHtml(partnerMatch.operator.name)} · コード ${escapeHtml(partnerMatch.operator.code)}</span><small>${escapeHtml(partnerMatch.matchType)}で一致</small></div>`
    : partnerMatch.status === 'suggested' && partnerMatch.candidates?.length
      ? `<div class="operator-match suggested"><b>取引先候補を選択</b><small>${escapeHtml(partnerMatch.matchType)}。誤登録防止のため候補を確認してください。</small><div class="operator-options">${partnerMatch.candidates.map(operator => `<button type="button" class="operator-option" data-operator-code="${escapeHtml(operator.code)}"><span>${escapeHtml(operator.name)}</span><small>コード ${escapeHtml(operator.code)}</small></button>`).join('')}</div></div>`
      : state.businessOperatorMaster.count
        ? `<div class="operator-match unmatched">取引先マスタに一致なし。支払先名は摘要へ出力し、取引先欄は空欄になります。</div>`
        : `<div class="operator-match unmatched">取引先マスタを読み込めません。取引先CSVの配置と形式を確認してください。</div>`;
  return `<div class="candidate-card"><div class="candidate-top"><div><span class="candidate-badge">AI読み取り候補 · 未確認</span><p>原本と照合してから入力欄に反映してください。${c.suggestion_source === '履歴' ? ' 勘定科目は同じ支払先の確定履歴から提案しています。' : ''}</p></div><button type="button" class="button secondary" id="apply-candidates">入力欄に反映</button></div><div class="candidate-grid">${details.map(([label,value]) => `<div><small>${label}</small><b>${escapeHtml(value ?? '読み取れず')}</b></div>`).join('')}</div>${partnerHtml}</div>`;
}
function openReview(id) {
  const file = state.files.find(item => item.id === id); if (!file) return;
  state.activeId = id;
  const linkedOperator = state.businessOperators.find(operator => operator.code === file.business_operator_code) || exactBusinessOperator(file.payee, file.registration_number);
  const isPdf = file.extension === '.pdf'; const src = `/api/file/${encodeURIComponent(id)}`;
  $('#dialog-content').innerHTML = `
    <div class="review-layout">
      <div class="preview-pane">${isPdf ? `<iframe src="${src}" title="証憑プレビュー"></iframe>` : `<img src="${src}" alt="${escapeHtml(file.filename)}">`}</div>
      <section class="edit-pane"><div class="eyebrow">DOCUMENT REVIEW</div><h2>証憑を確認</h2><p class="dialog-filename">${escapeHtml(file.filename)}</p>
        ${file.ocr_error ? `<div class="ocr-error">読み取り結果：${escapeHtml(file.ocr_error)}</div>` : ''}
        ${candidateBlock(file)}
        <form id="review-form" class="review-form">
          <label>取引日<input name="transaction_date" type="date" value="${escapeHtml(file.transaction_date)}"></label>
          <label>支払先<input name="payee" list="business-operator-options" value="${escapeHtml(linkedOperator?.name || file.payee)}" placeholder="レシート記載の店舗名"><datalist id="business-operator-options">${state.businessOperators.map(operator => `<option value="${escapeHtml(operator.name)}">`).join('')}</datalist></label>
          <input type="hidden" name="business_operator_code" value="${escapeHtml(linkedOperator?.code || '')}">
          <div class="form-pair"><label>合計金額<input name="total_amount" type="number" min="0" step="1" value="${file.total_amount ?? ''}" placeholder="0"></label><label>経費計上額<input name="expense_amount" type="number" min="0" step="1" value="${file.expense_amount ?? ''}" placeholder="0"></label></div>
          <div class="form-pair"><label>証憑の税額（照合用）<input name="tax_amount" type="number" min="0" step="1" value="${file.tax_amount ?? ''}" placeholder="任意"></label><label>登録番号<input name="registration_number" value="${escapeHtml(file.registration_number || linkedOperator?.registrationNumber || '')}" placeholder="任意"></label></div>
          <label>勘定科目<input name="account_name" list="account-options" value="${escapeHtml(file.account_name)}" placeholder="科目候補から選択"><datalist id="account-options">${state.accounts.map(account => `<option value="${escapeHtml(account.name)}">`).join('')}</datalist></label>
          <label>支払方法<input name="payment_name" value="${escapeHtml(file.payment_name)}" placeholder="例：現金"></label>
          <label>摘要<input name="memo" value="${escapeHtml(file.memo)}" placeholder="仕訳の摘要"></label>
          <p class="form-help">取引先マスタ${state.businessOperatorMaster.count}件を読み込み済みです。マスタ一致時は正式名を借方取引先としてCSVへ出力します。科目・摘要・取引先候補は証憑と照合して確定してください。</p>
          <div class="dialog-actions"><button type="button" class="button secondary" id="mark-excluded">経費対象外</button><button type="submit" class="button primary">経費対象として確定</button></div>
          ${file.status !== 'pending' ? `<button type="button" class="button text-button" id="return-pending">未確認に戻す</button>` : ''}
        </form></section></div>`;
  $('#review-form').addEventListener('submit', saveExpense);
  $('#mark-excluded').addEventListener('click', markExcluded);
  $('#return-pending')?.addEventListener('click', () => updateFile({ status:'pending' }));
  const payeeInput = $('#review-form').elements.namedItem('payee');
  const registrationInput = $('#review-form').elements.namedItem('registration_number');
  const operatorCodeInput = $('#review-form').elements.namedItem('business_operator_code');
  let manuallySelectedOperator = false;
  const linkExactPayee = canonicalize => {
    const operator = exactBusinessOperator(payeeInput.value, registrationInput.value);
    if (!operator) { operatorCodeInput.value = ''; manuallySelectedOperator = false; return; }
    operatorCodeInput.value = operator.code;
    manuallySelectedOperator = true;
    if (canonicalize) {
      payeeInput.value = operator.name;
      if (!registrationInput.value && operator.registrationNumber) registrationInput.value = operator.registrationNumber;
    }
  };
  payeeInput.addEventListener('input', () => linkExactPayee(false));
  payeeInput.addEventListener('change', () => linkExactPayee(true));
  registrationInput.addEventListener('input', () => linkExactPayee(false));
  registrationInput.addEventListener('change', () => linkExactPayee(true));
  $('#dialog-content').querySelectorAll('[data-operator-code]').forEach(button => button.addEventListener('click', () => {
    const operator = state.businessOperators.find(item => item.code === button.dataset.operatorCode);
    if (!operator) return;
    payeeInput.value = operator.name; operatorCodeInput.value = operator.code; manuallySelectedOperator = true;
    if (!registrationInput.value && operator.registrationNumber) registrationInput.value = operator.registrationNumber;
    const matchPanel = button.closest('.operator-match');
    matchPanel?.classList.add('selected');
    const matchHeading = matchPanel?.querySelector('b');
    if (matchHeading) matchHeading.textContent = '確認用の取引先を選択中';
    button.classList.add('selected');
    showToast(`取引先「${operator.name}」を選択しました。証憑と照合してください。`);
  }));
  $('#apply-candidates')?.addEventListener('click', () => {
    const c = JSON.parse(file.ocr_candidates_json);
    const currentManualSelection = manuallySelectedOperator ? state.businessOperators.find(operator => operator.code === operatorCodeInput.value) : null;
    const candidateOperator = c.business_operator_match?.status === 'matched' ? c.business_operator_match.operator : exactBusinessOperator(c.payee, c.registration_number);
    const matchedOperator = currentManualSelection || candidateOperator;
    for (const [key, value] of Object.entries({ transaction_date:c.transaction_date, payee:matchedOperator?.name || c.payee, total_amount:c.total_amount, tax_amount:c.tax_amount, registration_number:c.registration_number || matchedOperator?.registrationNumber, account_name:c.account_name, memo:c.memo })) {
      if (value != null) $('#review-form').elements.namedItem(key).value = value;
    }
    operatorCodeInput.value = matchedOperator?.code || '';
    manuallySelectedOperator = false;
    showToast('候補を入力欄へ反映しました。原本と照合してください。');
  });
  $('#review-dialog').showModal();
}
function formData() {
  const result = Object.fromEntries(new FormData($('#review-form')).entries());
  for (const key of ['total_amount','expense_amount','tax_amount']) result[key] = result[key] === '' ? null : Number(result[key]);
  return result;
}
async function saveExpense(event) {
  event.preventDefault(); const data = formData(); data.status = 'expense';
  try {
    const target = await api(`/api/file/${encodeURIComponent(state.activeId)}/archive-preview`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
    const collision = target.alreadyExists ? '\n同名ファイルがすでにあるため、コピーは上書きしません。' : '';
    if (!confirm(`確認した内容で確定し、原本のコピーを次の場所へ作成します。\n\n${target.destination}${collision}\n\n続けますか？`)) return;
  } catch (error) { showToast(error.message); return; }
  try { await updateFile(data); showToast('確定し、保管コピーを作成しました'); }
  catch (error) { showToast(error.message); }
}
async function markExcluded() {
  const data = formData(); data.status = 'excluded';
  if (!confirm('経費対象外として記録します。原本は移動・コピーしません。')) return;
  try { await updateFile(data); showToast('経費対象外として記録しました'); }
  catch (error) { showToast(error.message); }
}
async function updateFile(data) {
  await api(`/api/file/${encodeURIComponent(state.activeId)}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) });
  $('#review-dialog').close(); await loadState();
}
async function loadState() {
  const data = await api('/api/state'); state.files = data.files; state.accounts = data.expenseAccounts || []; state.businessOperators = data.businessOperators || []; state.businessOperatorMaster = data.businessOperatorMaster || { filename:'', count:0 };
  const warning = $('#root-warning');
  warning.classList.toggle('hidden', !data.missingRoot);
  warning.textContent = data.missingRoot ? `設定された証憑フォルダが見つかりません。環境変数 RECEIPTS_ROOT で場所を指定してください。現在の設定: ${data.root}` : '';
  render();
}
function setView(view) {
  state.view = view;
  const labels = { inbox:'証憑を確認', archive:'確認済み', export:'CSVエクスポート', settings:'設定' };
  $('#crumb').textContent = labels[view]; $('#page-title').textContent = labels[view];
  const isSettings = view === 'settings';
  $('#settings-panel').classList.toggle('hidden', !isSettings);
  $('.stats-row').classList.toggle('hidden', isSettings);
  $('.workspace-card').classList.toggle('hidden', isSettings);
  $('.footnote').classList.toggle('hidden', isSettings);
  $('#page-subtitle').textContent = isSettings ? '証憑の読み取りと保存先を設定します。' : view === 'export' ? '確認済みの証憑からMoney Forward仕訳CSVを作成します。' : view === 'archive' ? '経費対象として確認済みの証憑です。' : '内容を確認し、経費にする証憑を整理します。';
  state.filter = view === 'archive' || view === 'export' ? 'expense' : 'pending';
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.filter === state.filter));
  render();
  if (isSettings) loadSettings().catch(error => showToast(error.message));
}

$('#scan').addEventListener('click', async () => {
  const button = $('#scan'); button.disabled = true; button.innerHTML = '<span>↻</span> スキャン中…';
  try { const result = await api('/api/scan', {method:'POST'}); await loadState(); showToast(result.missingRoot ? '証憑フォルダが見つかりません' : `スキャン完了：新規${result.added}件、変更${result.changed}件`); }
  catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.innerHTML = '<span>↻</span> 再スキャン'; }
});
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => {
  document.querySelector('.tab.active')?.classList.remove('active'); button.classList.add('active'); state.filter = button.dataset.filter; render();
}));
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  document.querySelector('.nav-item.active')?.classList.remove('active'); button.classList.add('active'); setView(button.dataset.view);
}));
$('#search').addEventListener('input', event => { state.query = event.target.value; render(); });
$('#select-all').addEventListener('change', event => { document.querySelectorAll('.file-check:not(:disabled)').forEach(input => input.checked = event.target.checked); updateSelected(); });
$('#file-list').addEventListener('click', event => { const button = event.target.closest('[data-open]'); if (button) openReview(button.dataset.open); });
$('#file-list').addEventListener('change', event => { if (event.target.matches('.file-check')) updateSelected(); });
$('#read-selected').addEventListener('click', async () => {
  const ids = [...document.querySelectorAll('.file-check:checked')].map(input => input.value);
  if (!ids.length) return;
  try {
    const result = await api('/api/ocr/jobs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ids})});
    if (!result.queued) { showToast('選択した証憑はすでにキューにあるか、対象外です'); return; }
    showToast(`${result.queued}件の読み取りをキューに追加しました`); await loadJobs(); await loadState(); startQueuePolling();
  } catch (error) { showToast(error.message); }
});
$('#queue-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-retry]'); if (!button) return;
  try { await api(`/api/ocr/retry/${encodeURIComponent(button.dataset.retry)}`, {method:'POST'}); await loadJobs(); startQueuePolling(); }
  catch (error) { showToast(error.message); }
});
$('#queue-toggle').addEventListener('click', () => {
  const expanded = $('#queue-toggle').getAttribute('aria-expanded') !== 'true';
  $('#queue-toggle').setAttribute('aria-expanded', String(expanded));
  $('#queue-list').hidden = !expanded;
  $('#queue-panel').classList.toggle('expanded', expanded);
});
$('#review-dialog').addEventListener('click', event => { if (event.target === $('#review-dialog')) $('#review-dialog').close(); });
$('#api-key-form').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('#api-key'); const button = event.submitter; const apiKey = input.value.trim();
  if (!apiKey) { showToast('APIキーを入力してください'); return; }
  button.disabled = true;
  try { await api('/api/settings/api-key', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({apiKey})}); input.value = ''; await loadSettings(); showToast('APIキーをWindows資格情報マネージャーへ保存しました'); }
  catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});
$('#clear-api-key').addEventListener('click', async () => {
  if (!confirm('Windows資格情報マネージャーに保存したAPIキーを削除しますか？')) return;
  try { await api('/api/settings/api-key', {method:'DELETE'}); await loadSettings(); showToast('APIキーを削除しました'); }
  catch (error) { showToast(error.message); }
});

updatePeriod();
Promise.all([loadState(), loadSettings(), loadJobs()]).then(() => {
  if (state.jobs.some(job => ['waiting','processing'].includes(job.status))) startQueuePolling();
}).catch(error => showToast(error.message));
