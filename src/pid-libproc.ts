import { dlopen, FFIType, ptr } from "bun:ffi";

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136;
const PPID_OFFSET = 16;
const START_SECONDS_OFFSET = 120;

function openLibproc() {
  return dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
}

let libproc: ReturnType<typeof openLibproc> | undefined;

export function libprocProcess(pid: number): { parentPid: number; startedAt: string } | null {
  libproc ??= openLibproc();
  const info = new Uint8Array(PROC_BSDINFO_SIZE);
  const written = libproc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(info), PROC_BSDINFO_SIZE);
  if (written !== PROC_BSDINFO_SIZE) return null;
  const view = new DataView(info.buffer);
  return {
    parentPid: view.getUint32(PPID_OFFSET, true),
    startedAt: String(view.getBigUint64(START_SECONDS_OFFSET, true)),
  };
}
