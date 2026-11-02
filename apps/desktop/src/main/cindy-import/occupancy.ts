import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { importError } from './snapshot';

const execute = promisify(execFile);
// Windows Restart Manager only enumerates processes holding these exact files.
// No RmShutdown, lock acquisition, source-side SQLite connection or source write.
const windowsProbe = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LexReadFileHolders {
  [StructLayout(LayoutKind.Sequential)] public struct Unique { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Info {
    public Unique process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
    public uint type, status, session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint handle, uint count, [MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.LPWStr)] string[] files, uint apps, IntPtr app, uint services, IntPtr service);
  [DllImport("rstrtmgr.dll")] public static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] Info[] info, ref uint reasons);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
  public static int[] Query(string[] files) {
    uint h; if(RmStartSession(out h, 0, new StringBuilder(33)) != 0) throw new Exception("probe");
    try {
      if(RmRegisterResources(h, (uint)files.Length, files, 0, IntPtr.Zero, 0, IntPtr.Zero) != 0) throw new Exception("probe");
      for(int attempt=0; attempt<3; attempt++) {
        uint need=0, count=0, reason=0;
        int status=RmGetList(h, out need, ref count, null, ref reason);
        if(status==0) return new int[0];
        if(status!=234 || need>4096) throw new Exception("probe");
        var info=new Info[need]; count=need;
        status=RmGetList(h, out need, ref count, info, ref reason);
        if(status==234) continue;
        if(status!=0) throw new Exception("probe");
        var result=new int[count]; for(int i=0; i<count; i++) result[i]=info[i].process.pid;
        return result;
      }
      throw new Exception("probe");
    } finally { RmEndSession(h); }
  }
}
'@
[LexReadFileHolders]::Query([string[]](ConvertFrom-Json $env:LEX_IMPORT_PROBE_FILES)) | ForEach-Object { $_ }
`;

interface LsofResult { code: unknown; stdout?: string; stderr?: string; killed?: boolean; signal?: unknown }
/** lsof exits 1 when any requested file has no holder, even if others match.
 * Its p/f field output is still valid; diagnostics and execution failures are not. */
export function parseLsofHolders(result: LsofResult): number[] {
  if ((result.code !== 0 && result.code !== 1) || result.killed || result.signal
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.stderr.trim()) {
    throw importError('sourceUnreadable');
  }
  const holders = new Set<number>();
  let hasProcess = false;
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (/^p\d+$/.test(line)) {
      const pid = Number(line.slice(1));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw importError('sourceUnreadable');
      holders.add(pid); hasProcess = true;
    } else if (!hasProcess || !/^f\S+$/.test(line)) {
      throw importError('sourceUnreadable');
    }
  }
  return [...holders];
}

/** The DB's WAL/SHM presence is not occupancy; ask the OS for open handles. */
export async function sourceDatabaseHolders(file: string): Promise<number[]> {
  const files: string[] = [];
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    let stat;
    try {
      stat = await fs.lstat(file + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && suffix) continue;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw importError('sourceMissing');
      throw importError('sourceUnreadable');
    }
    if (!stat.isFile()) throw importError('unsafePath');
    files.push(file + suffix);
  }
  try {
    const result = process.platform === 'win32'
      ? await execute(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', windowsProbe], { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
          env: { ...process.env, LEX_IMPORT_PROBE_FILES: JSON.stringify(files) } })
      : await execute(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-F', 'p', '--', ...files],
        { timeout: 10_000, maxBuffer: 64 * 1024 });
    if (process.platform !== 'win32') return parseLsofHolders({ ...result, code: 0 });
    if (result.stderr.trim()) throw importError('sourceUnreadable');
    return [...new Set(result.stdout.split(/\r?\n/).filter(line => process.platform === 'win32' ? /^\d+$/.test(line) : /^p\d+$/.test(line))
      .map(line => Number(line.replace(/^p/, ''))).filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  } catch (error) {
    const result = error as LsofResult;
    if (process.platform !== 'win32') return parseLsofHolders(result);
    throw importError('sourceUnreadable');
  }
}
