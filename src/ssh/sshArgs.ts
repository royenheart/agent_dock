/**
 * ssh 命令构造（纯函数，不依赖 vscode，供单测直接断言）。
 * remoteExec / currentExec / commands 共用，避免各处手写参数漂移。
 */

/** Quote a string for inclusion inside a POSIX single-quoted context. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Win32-OpenSSH 不支持 ControlMaster（PowerShell/Win32-OpenSSH#405），
 * 带这些选项时每次连接都以 getsockname failed: Not a socket 失败。
 */
export function buildSshBaseArgs(persist: string, platform: NodeJS.Platform): string[] {
  const reuse =
    persist === '0' || platform === 'win32'
      ? []
      : ['-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/agentdock-cm-%r@%h:%p', '-o', `ControlPersist=${persist}`];
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...reuse, '-T'];
}

/** 批量 realpath：逐行对齐输出，每行必有结果（失败回显原路径）。 */
export function buildRealpathScript(paths: string[]): string {
  return paths.map((p) => `realpath ${shq(p)} 2>/dev/null || printf '%s\\n' ${shq(p)}`).join('\n');
}

/** [ -d ] 守卫区分「目录不存在」与「ssh 失败」：管道经 sed 后退出码恒为 0，只能靠标记识别。 */
export function buildListDirsScript(path: string, noentMarker: string): string {
  return `if [ -d ${shq(path)} ]; then ls -1Ap ${shq(path)} 2>/dev/null | grep '/$' | sed 's|/$||'; else echo ${noentMarker}; fi`;
}
