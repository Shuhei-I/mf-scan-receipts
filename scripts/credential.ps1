param([Parameter(Mandatory=$true)][ValidateSet('get','set','delete')][string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct ReceiptCredential {
  public UInt32 Flags;
  public UInt32 Type;
  public IntPtr TargetName;
  public IntPtr Comment;
  public long LastWritten;
  public UInt32 CredentialBlobSize;
  public IntPtr CredentialBlob;
  public UInt32 Persist;
  public UInt32 AttributeCount;
  public IntPtr Attributes;
  public IntPtr TargetAlias;
  public IntPtr UserName;
}

public static class ReceiptCredentialApi {
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref ReceiptCredential credential, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredFree", SetLastError=false)]
  public static extern void CredFree(IntPtr buffer);
}
'@
$target = 'ReceiptDesk.OpenAI'
switch ($Action) {
  'set' {
    $secret = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($secret)) { throw 'API key is empty' }
    $bytes = [Text.Encoding]::UTF8.GetBytes($secret.Trim())
    $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    $targetPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($target)
    $userPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('Receipt Desk')
    try {
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
      $credential = New-Object ReceiptCredential
      $credential.Type = 1
      $credential.TargetName = $targetPtr
      $credential.UserName = $userPtr
      $credential.CredentialBlobSize = [UInt32]$bytes.Length
      $credential.CredentialBlob = $blob
      $credential.Persist = 2
      if (-not [ReceiptCredentialApi]::CredWrite([ref]$credential, 0)) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "Credential Manager write failed: $code"
      }
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($targetPtr)
      [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($userPtr)
      [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($blob)
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
    [Console]::Out.Write('ok')
  }
  'get' {
    $ptr = [IntPtr]::Zero
    if (-not [ReceiptCredentialApi]::CredRead($target, 1, 0, [ref]$ptr)) {
      [Console]::Out.Write('')
      exit 0
    }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][ReceiptCredential])
      $bytes = New-Object byte[] $credential.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
      [Console]::Out.Write([Convert]::ToBase64String($bytes))
      [Array]::Clear($bytes, 0, $bytes.Length)
    } finally { [ReceiptCredentialApi]::CredFree($ptr) }
  }
  'delete' {
    [void][ReceiptCredentialApi]::CredDelete($target, 1, 0)
    [Console]::Out.Write('ok')
  }
}
