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

export interface TermDimensions {
  rows: number;
  cols: number;
}

/**
 * 交互式终端里的 ssh argv（不含 'ssh' 本体，刻意不带 BatchMode —— 要允许密码交互）。
 * 客户端终端没有本地 pty，必须 -tt 强制分配远程 pty；尺寸随 stty 注入远程命令。
 * 不传 remoteCommand 时开登录 shell，等价于裸 `ssh host`。
 */
export function buildInteractiveSshArgs(
  server: { host: string; user?: string; port?: number },
  dims: TermDimensions,
  remoteCommand?: string,
): string[] {
  const cmd = `stty rows ${dims.rows} cols ${dims.cols}; ${remoteCommand ?? 'exec "$SHELL" -l'}`;
  const dest = `${server.user ? `${server.user}@` : ''}${server.host}`;
  return ['-tt', ...(server.port ? ['-p', String(server.port)] : []), dest, cmd];
}

export interface SpawnSpec {
  file: string;
  args: string[];
  /** 无 pty 的退化模式：终端侧手动回显输入，回车按目标程序期望的行结束符转换后写入。 */
  dumb?: { enter: '\r\n' | '\n' };
}

/** 真 pty 下的 ssh argv：本地已是 tty，仅在带远程命令时补 -t 分配远程 pty（交互式 agent CLI 需要）。 */
export function buildPtySshArgs(
  server: { host: string; user?: string; port?: number },
  remoteCommand?: string,
): string[] {
  const dest = `${server.user ? `${server.user}@` : ''}${server.host}`;
  return [
    ...(remoteCommand ? ['-t'] : []),
    ...(server.port ? ['-p', String(server.port)] : []),
    dest,
    ...(remoteCommand ? [remoteCommand] : []),
  ];
}

/**
 * 客户端本机 shell 的启动方式：POSIX 用 script(1) 包出真 pty（readline/颜色/Ctrl-C 才正常），
 * Windows 没有 script，直起 PowerShell（管道无回显、需 CRLF 行结束，故标记 dumb）。
 */
export function buildClientShellSpawn(platform: NodeJS.Platform, dims: TermDimensions): SpawnSpec {
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'], dumb: { enter: '\r\n' } };
  }
  const inner = `stty rows ${dims.rows} cols ${dims.cols}; exec "$SHELL" -l`;
  if (platform === 'linux') {
    // util-linux script: -c 接命令字符串（内部经 sh -c 执行）
    return { file: 'script', args: ['-qec', inner, '/dev/null'] };
  }
  // BSD script（macOS 等）：file 在前，命令以 argv 形式随后
  return { file: 'script', args: ['-q', '/dev/null', 'sh', '-c', inner] };
}
