# Runs SQL on a Supabase project via the Management API.
# Token is read at runtime from Windows Credential Manager ("Supabase CLI" entry) - never stored here.
# Usage: .\sb-mgmt-query.ps1 -Ref <project-ref> -Query "select 1" [-QueryFile path.sql]
param(
  [Parameter(Mandatory=$true)][string]$Ref,
  [string]$Query,
  [string]$QueryFile
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CredMan {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  public static byte[] GetBlob(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) throw new Exception("CredRead failed for " + target);
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      byte[] blob = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);
      return blob;
    } finally { CredFree(ptr); }
  }
}
"@

$tok = [System.Text.Encoding]::UTF8.GetString([CredMan]::GetBlob("Supabase CLI:supabase")).Trim()
if (-not $tok) { throw "Empty token from Credential Manager" }

if ($QueryFile) { $Query = Get-Content -Raw -Encoding UTF8 $QueryFile }   # repo files are UTF-8; PS5.1 default is ANSI
if (-not $Query) { throw "No query given" }

$body = @{ query = $Query } | ConvertTo-Json -Depth 4
try {
  # charset=utf-8 is REQUIRED: PS 5.1 otherwise encodes the body as Latin-1, silently
  # best-fit-mapping non-ASCII (em-dash became a hyphen in seeded data before this fix).
  $resp = Invoke-RestMethod -Method Post -Uri "https://api.supabase.com/v1/projects/$Ref/database/query" `
    -Headers @{ Authorization = "Bearer $tok" } -ContentType "application/json; charset=utf-8" -Body $body
  $resp | ConvertTo-Json -Depth 10
} catch {
  $r = $_.Exception.Response
  if ($r) {
    $reader = New-Object System.IO.StreamReader($r.GetResponseStream())
    Write-Output ("HTTP error: " + [int]$r.StatusCode + " " + $reader.ReadToEnd())
  } else { throw }
}
