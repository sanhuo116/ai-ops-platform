#Requires -Version 5.1
<#
  Windows 凭据管理器（Credential Manager）通用凭据的写入/读取/探测/删除封装。

  用法：
    .\win_credentials.ps1 get    -TargetName "com.byai.tencent-business-data-query:tencent-secret-id"
    .\win_credentials.ps1 exists -TargetName "com.byai.tencent-business-data-query:tencent-secret-id"
    .\win_credentials.ps1 set    -TargetName "com.byai.tencent-business-data-query:tencent-secret-id" -UserName "tencent-secret-id"
    .\win_credentials.ps1 delete -TargetName "com.byai.tencent-business-data-query:tencent-secret-id"

  退出码约定：
    get    : 0=成功(stdout=明文)  2=条目不存在  3=读取失败(无权/其他)
    exists : 0=存在(stdout=true) 1=不存在(stdout=false) 2=读取失败
    set    : 0=成功  3=失败
    delete : 0=成功或原本不存在  3=失败

  set 通过 Read-Host 交互式读取，明文值绝不出现在命令行（避免泄露到进程列表/历史）。
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('get', 'exists', 'set', 'delete')]
    [string]$Command,

    [Parameter(Mandatory = $true)]
    [string]$TargetName,

    [string]$UserName = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace ByaiCred {
    public static class CredApi {
        public const int CRED_TYPE_GENERIC = 1;
        public const int CRED_PERSIST_LOCAL_MACHINE = 2;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct CREDENTIAL {
            public int Flags;
            public int Type;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string TargetName;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string Comment;
            [MarshalAs(UnmanagedType.Struct)]
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist;
            public int AttributeCount;
            public IntPtr Attributes;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string TargetAlias;
            [MarshalAs(UnmanagedType.LPWStr)]
            public string UserName;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredWrite(ref CREDENTIAL credential, int flags);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool CredDelete(string target, int type, int flags);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern void CredFree(IntPtr cred);
    }
}
"@

$ERROR_NOT_FOUND = 1168

function Get-PlainFromBlob {
    param([IntPtr]$Ptr)
    $raw = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
        $Ptr, [type][ByaiCred.CredApi+CREDENTIAL])
    if ($raw.CredentialBlobSize -le 0) { return '' }
    $bytes = New-Object byte[] $raw.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy(
        $raw.CredentialBlob, $bytes, 0, $raw.CredentialBlobSize)
    return [System.Text.Encoding]::Unicode.GetString($bytes)
}

switch ($Command) {
    'get' {
        $ptr = [IntPtr]::Zero
        $ok = [ByaiCred.CredApi]::CredRead(
            $TargetName, [ByaiCred.CredApi]::CRED_TYPE_GENERIC, 0, [ref]$ptr)
        if (-not $ok) {
            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($err -eq $ERROR_NOT_FOUND) {
                [Console]::Error.WriteLine('NOT_FOUND')
                exit 2
            }
            [Console]::Error.WriteLine("READ_FAILED:$err")
            exit 3
        }
        try {
            Write-Output (Get-PlainFromBlob $ptr)
        } finally {
            [ByaiCred.CredApi]::CredFree($ptr)
        }
        exit 0
    }

    'exists' {
        $ptr = [IntPtr]::Zero
        $ok = [ByaiCred.CredApi]::CredRead(
            $TargetName, [ByaiCred.CredApi]::CRED_TYPE_GENERIC, 0, [ref]$ptr)
        if ($ok) {
            [ByaiCred.CredApi]::CredFree($ptr)
            Write-Output 'true'
            exit 0
        }
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($err -eq $ERROR_NOT_FOUND) {
            Write-Output 'false'
            exit 1
        }
        [Console]::Error.WriteLine("READ_FAILED:$err")
        exit 2
    }

    'set' {
        $prompt = if ($UserName) { "请输入 $UserName 的值" } else { '请输入凭据值' }
        $secure = Read-Host -Prompt $prompt -AsSecureString
        $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try {
            $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($bstr)
            $bytes = [System.Text.Encoding]::Unicode.GetBytes($plain)
            $cred = New-Object ByaiCred.CredApi+CREDENTIAL
            $cred.Type = [ByaiCred.CredApi]::CRED_TYPE_GENERIC
            $cred.TargetName = $TargetName
            $cred.UserName = $UserName
            $cred.Persist = [ByaiCred.CredApi]::CRED_PERSIST_LOCAL_MACHINE
            $cred.CredentialBlobSize = $bytes.Length
            $cred.CredentialBlob = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
            try {
                [System.Runtime.InteropServices.Marshal]::Copy(
                    $bytes, 0, $cred.CredentialBlob, $bytes.Length)
                if (-not [ByaiCred.CredApi]::CredWrite([ref]$cred, 0)) {
                    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    [Console]::Error.WriteLine("WRITE_FAILED:$err")
                    exit 3
                }
            } finally {
                [System.Runtime.InteropServices.Marshal]::FreeHGlobal($cred.CredentialBlob)
            }
            Write-Output 'OK'
            exit 0
        } finally {
            [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    'delete' {
        if (-not [ByaiCred.CredApi]::CredDelete(
                $TargetName, [ByaiCred.CredApi]::CRED_TYPE_GENERIC, 0)) {
            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($err -eq $ERROR_NOT_FOUND) {
                Write-Output 'ALREADY_ABSENT'
                exit 0
            }
            [Console]::Error.WriteLine("DELETE_FAILED:$err")
            exit 3
        }
        Write-Output 'DELETED'
        exit 0
    }
}