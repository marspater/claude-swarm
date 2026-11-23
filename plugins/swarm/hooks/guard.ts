// The shared-checkout commit guard and the member's board-command identity check: what a Bash command runs, read
// as the shell runs it. Needs the engine only for the file system and git.
import type { EngineInterface } from 'claude-code'

import { boardCalls, CASE_PATTERN, closesAfter, COMMITTING, GIT_BUILTINS, launches, makesCommit, NAMES_COMMIT, RUNNERS, scanShell, scriptsRun, shellLaunch, SHELLS, shellWords, type Statement, unwrap, withoutRedirects } from './command'
import type { Roster } from './roster'

export function normalizePath(p: string): string {
  const isAbs = p.startsWith('/')
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      else if (!isAbs) parts.push('..')
    } else {
      parts.push(part)
    }
  }
  return (isAbs ? '/' : '') + parts.join('/')
}

export async function resolveRealPath($: EngineInterface, absPath: string): Promise<string> {
  let probe = absPath
  const suffix: string[] = []
  while (probe && probe !== '/') {
    const st = await $.fs.stat(probe, { resolve: true }).catch(() => undefined)
    if (st?.realPath) {
      const base = normalizePath(st.realPath)
      return suffix.length > 0 ? normalizePath(`${base}/${suffix.join('/')}`) : base
    }
    const slash = probe.lastIndexOf('/')
    if (slash <= 0) break
    suffix.unshift(probe.slice(slash + 1))
    probe = probe.slice(0, slash)
  }
  return absPath
}

// What may stand before a command and leaves it the same command, with its own options: the short ones that take a
// value (`valued`), and for a wrapper read strictly, the short ones that take none (`flags`) and its long ones (`long`,
// true for those that take a value). An option a strict wrapper does not list leaves the command unread. `operands`
// are the words after the options that are the wrapper's own (timeout's duration). `inShell`: the command runs in the
// shell itself, so a `cd` or an `exit` behind it acts there; behind any other wrapper it is a child's, and moves nothing.
// `chdir`: the options whose value is the folder the command runs in; `away`: the ones that take it to a folder this
// cannot tell (a login shell's home). `split`: the option whose value is a command line of its own (env -S).
// `fromStdin`: what it runs takes further words from its input (xargs). `joins`: what it runs is its words joined
// into a script for `sh -c`, unless the option in `exec` is given (watch).
type Wrapper = {
  valued: string; flags?: string; long?: Record<string, boolean>; operands?: number; inShell?: true
  chdir?: string; away?: string; split?: string; fromStdin?: true; joins?: true; exec?: string
}
const PREFIXES = new Map<string, Wrapper>([
  ['time', { valued: 'of', inShell: true }], ['command', { valued: '', inShell: true }], ['builtin', { valued: '', inShell: true }], ['exec', { valued: 'a' }],
  ['nohup', { valued: '' }],
  ['env', { valued: 'uCSP', long: { chdir: true, 'split-string': true, unset: true, ignore_environment: false, 'ignore-environment': false, null: false, debug: false }, chdir: 'C', split: 'S' }],
  ['nice', { valued: 'n', flags: '0123456789', long: { adjustment: true } }],
  ['timeout', { valued: 'sk', flags: 'v', long: { signal: true, 'kill-after': true, foreground: false, 'preserve-status': false, verbose: false }, operands: 1 }],
  ['xcrun', { valued: '', flags: 'rlnkv', long: { sdk: true, toolchain: true, run: false, log: false, 'no-cache': false, 'kill-cache': false, verbose: false } }],
  ['stdbuf', { valued: 'ioe', flags: '', long: { input: true, output: true, error: true } }],
  ['caffeinate', { valued: 'tw', flags: 'dimsu' }],
  ['sudo', { valued: 'ugCDhprtTU', flags: 'AbBEeHiKklnPSsVv', chdir: 'D', away: 'i', long: {
    user: true, group: true, 'close-from': true, chdir: true, host: true, prompt: true, role: true, type: true, 'command-timeout': true,
    'other-user': true, askpass: false, background: false, bell: false, edit: false, 'preserve-env': false, 'set-home': false, login: false,
    'remove-timestamp': false, 'reset-timestamp': false, list: false, 'non-interactive': false, 'preserve-groups': false, stdin: false,
    shell: false, version: false, validate: false } }],
  ['xargs', { valued: 'IdEaLnPs', flags: '0prtxo', fromStdin: true, long: {
    null: false, 'arg-file': true, delimiter: true, 'max-args': true, 'max-procs': true, 'max-lines': true, 'max-chars': true,
    'process-slot-var': true, verbose: false, interactive: false, 'no-run-if-empty': false, 'open-tty': false, exit: false, 'show-limits': false } }],
  ['watch', { valued: 'nq', flags: 'dtbegcxpwr', joins: true, exec: 'x', long: {
    interval: true, equexit: true, differences: false, 'no-title': false, beep: false, errexit: false, chgexit: false, color: false,
    'no-color': false, exec: false, precise: false, 'no-wrap': false, 'no-rerun': false } }],
])
// Commands that print or read their words, or set the shell's own state, and run none of them.
const INERT = new Set(['echo', 'printf', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'test', '[', '[[', 'true', 'false', ':', 'type', 'which',
  'man', 'head', 'tail', 'wc', 'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'unset', 'read', 'shift', 'let', 'shopt', 'wait'])
/**
 * True when a shared writer's command may make a commit in the shared checkout: `git commit` and the other commands
 * that make one (see makesCommit), however the command quotes, wraps, nests or routes them. A part it cannot read
 * for sure is a commit when it names one.
 */
export async function commitsInSharedCheckout($: EngineInterface, command: string, checkout: string): Promise<boolean> {
  // Compared as the file system names them: the run folder and a `cd` may spell one checkout two ways.
  const cwd = await resolveRealPath($, checkout)
  const directoryAfter = (current: string | undefined, path?: string) => {
    // A path the shell expands (`$PWD`, `~`, a glob) leads where this cannot tell: it may be the checkout.
    if (path === undefined || path === '_' || /[$`~*?[{]/.test(path)) return undefined
    if (!path || path === '.' || path === './') return current
    if (path.startsWith('/')) return normalizePath(path)
    return current && normalizePath(`${current}/${path}`)
  }
  const roots = new Map<string, Promise<string | undefined>>()
  const checkoutRoot = (dir: string) => {
    const found = roots.get(dir) ?? $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
      .then(result => {
        const root = result.stdout.replace(/\r?\n$/, '')
        return result.exitCode === 0 && root.startsWith('/') ? resolveRealPath($, root) : undefined
      }, () => undefined)
    roots.set(dir, found)
    return found
  }
  const insideCheckout = async (given: string | undefined) => {
    if (given === undefined) return true
    const dir = await resolveRealPath($, given)
    if (dir === cwd) return true
    const [root, target] = await Promise.all([checkoutRoot(cwd), checkoutRoot(dir)])
    if (root && target) return root === target
    if (root) return dir === root || dir.startsWith(`${root}/`)
    if (!dir.startsWith(`${cwd}/`)) return cwd.startsWith(`${dir}/`)
    // If Git cannot answer, preserve the linked-worktree fallback inside the project.
    const name = /^\/\.claude\/worktrees\/([^/]+)/.exec(dir.slice(cwd.length))?.[1]
    if (name === undefined) return true
    const link = await $.fs.read(`${cwd}/.claude/worktrees/${name}/.git`).catch(() => '')
    return !/^gitdir:\s*\S/.test(link.trim())
  }
  // Where the shell may be: `undefined` stands for a folder this cannot tell, which may be the checkout.
  type Dirs = Set<string | undefined>
  const union = (...sets: Dirs[]): Dirs => new Set(sets.flatMap(set => [...set]))
  const UNKNOWN: Dirs = new Set([undefined])
  // A repository named by GIT_DIR or GIT_WORK_TREE anywhere in the command (an export, a declare, a prefix) cannot
  // be told from the folder: every commit in it is refused. Config given in the environment may define aliases.
  const isNamedElsewhere = /\bGIT_(?:DIR|WORK_TREE)=/.test(command)
  const isConfiguredElsewhere = /\b(?:GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)|HOME|XDG_CONFIG_HOME)=/.test(command) || /\bgit\s+(?:[^\n;]*\s)?-c\s+include(?:If\.[^=]+)?\.path=/i.test(command) || /\bgit\s+config\b/.test(command) || />\s*[^\s;|&]*(?:config|\.gitconfig)\b/i.test(command)
  // What the command's own assignments give its variables (`C='git commit -m x'`), read off its statements, not off
  // heredoc bodies or comments: a variable one of them names may stand for a commit.
  const values = new Map<string, string[]>()
  for (const script of scriptsRun(command)) {
    for (const { text } of scanShell(script)) {
      for (const word of shellWords(text)) {
        const [, key, value] = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(word) ?? []
        if (key) values.set(key, [...values.get(key) ?? [], value!])
      }
    }
  }
  const viaVariable = (text: string) => [...text.matchAll(/\$\{?([A-Za-z_]\w*)/g)].some(([, key]) => (values.get(key!) ?? []).some(value => NAMES_COMMIT.test(`git ${value}`)))
  // Words this cannot read (a variable, a substitution, a placeholder) that may stand for a commit: one of the words
  // beside them names one, or a variable among them was given one.
  const mayCommit = (words: readonly string[]) => words.some(word => COMMITTING.includes(word)) || viaVariable(words.join(' '))
  const namesDirectCommit = new RegExp(`\\bgit\\s+(?:${COMMITTING.join('|')})\\b`)
  // Aliases the command itself sets with `git config alias.<name> <value>`, and the functions it defines.
  const aliases = new Map<string, string>()
  const functions = new Set<string>()
  // Shell aliases the command defines (`alias g=git`): a later command named by one runs its text.
  const shellAliases = new Map<string, string>()
  // What `git <sub>` stands for in `dir`: the alias's text, '' for none, undefined when it cannot be told.
  const configured = new Map<string, Promise<string | undefined>>()
  const aliasOf = (sub: string, dir: string | undefined): Promise<string | undefined> => {
    if (aliases.has(sub)) return Promise.resolve(aliases.get(sub))
    if (isConfiguredElsewhere) return Promise.resolve(undefined)
    const key = `${dir ?? cwd}\0${sub}`
    const asked = configured.get(key) ?? $.process.run(['git', '-C', dir ?? cwd, 'config', '--get', `alias.${sub}`], { timeoutMs: 5000 })
      // git answers 1 for a name with no alias.
      .then(answer => answer.exitCode === 0 ? answer.stdout.trim() : answer.exitCode === 1 ? '' : undefined, () => undefined)
    configured.set(key, asked)
    return asked
  }
  type End = { hit: boolean; ok: Dirs; failed: Dirs }
  const HIT: End = { hit: true, ok: UNKNOWN, failed: UNKNOWN }
  // `git <args>` run from each of `from`, with what came before it on its line (`env`, `xargs`).
  const git = async (args: readonly string[], from: Dirs, isElsewhereAlready: boolean, fromStdin: boolean, depth: number, hops = 0): Promise<boolean> => {
    for (const dir of from) {
      let gitDir = dir
      let isMoved = isElsewhereAlready
      // Aliases this command line gives with -c (undefined for one taken from the environment by --config-env).
      const given = new Map<string, string | undefined>()
      let i = 0
      for (; i < args.length; i++) {
        const tok = args[i]!
        if (tok.startsWith('-C')) gitDir = directoryAfter(gitDir, tok === '-C' ? args[++i] : tok.slice(2))
        else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(tok)) {
          isMoved = true
          if (!tok.includes('=')) i++
        } else if (tok === '-c' || tok === '--config-env' || tok.startsWith('--config-env=')) {
          const value = tok.includes('=') ? tok.slice('--config-env='.length) : args[++i] ?? ''
          const alias = /^alias\.([^=]+)=([\s\S]*)$/i.exec(value)
          if (alias) given.set(alias[1]!.toLowerCase(), tok === '-c' ? alias[2] : undefined)
        } else if (tok.startsWith('-c')) {
          return false // Git rejects an attached -c argument before dispatching a subcommand.
        } else if (['--namespace', '--super-prefix', '--attr-source', '--exec-path', '--list-cmds'].includes(tok)) i++
        else if (!tok.startsWith('-')) break
      }
      const sub = args[i]
      const rest = args.slice(i + 1)
      const inside = async () => isMoved || await insideCheckout(gitDir)
      if (sub === undefined) {
        // `xargs git` takes its command from its input.
        if (fromStdin && await inside()) return true
        continue
      }
      if (sub === 'config') {
        // `git config [options] [set] alias.<name> <value>`: what a later `git <name>` in this command runs. The key
        // is found by its name, not its place: an option's value (`--file .git/config`) stands before it.
        const words = rest.filter(word => !word.startsWith('-'))
        const at = words.findIndex(word => /^alias\./i.test(word))
        const value = at < 0 ? undefined : words[at + 1]
        if (at >= 0 && value !== undefined) aliases.set(words[at]!.slice(6).toLowerCase(), value)
        continue
      }
      if (makesCommit(sub, rest)) {
        if (await inside()) return true
        continue
      }
      // Git lets no alias stand for one of its own commands.
      if (GIT_BUILTINS.has(sub) || ['merge', 'cherry-pick', 'revert', 'am', 'rebase', 'pull'].includes(sub)) continue
      // A command word that is no plain name (`{}` under xargs or find, a glob) is filled in later: it may be any.
      if (fromStdin || !/^[a-z][a-z0-9-]*$/.test(sub) || hops > 4) {
        if (await inside()) return true
        continue
      }
      const alias = given.has(sub) ? given.get(sub) : await aliasOf(sub, gitDir)
      if (alias === undefined) {
        if (await inside()) return true
      } else if (alias.startsWith('!')) {
        // A shell alias runs at the top of the repository, which may be the checkout.
        if ((await run(alias.slice(1), new Set([isMoved ? undefined : gitDir]), depth + 1)).hit) return true
      } else if (alias !== '') {
        if (await git([...shellWords(alias), ...rest], new Set([gitDir]), isMoved, false, depth, hops + 1)) return true
      }
    }
    return false
  }
  // One simple command, its words read as the shell runs them (`"git" commit`, `\git commit` and `git "commit"` are
  // all a commit), run from `here`. `isChildAlready`: it runs as a process of its own, so a cd there moves nothing.
  const simple = async (input: readonly string[], here: Dirs, depth: number, isChildAlready = false): Promise<End> => {
    const words = [...input]
    // A repository named by --git-dir, --work-tree or their variables cannot be told from the folder: refused.
    let isElsewhere = isNamedElsewhere
    let isChild = isChildAlready
    let fromStdin = false
    // Folders a wrapper moves the command to, in order, `undefined` for one this cannot tell.
    const chdirs: Array<string | undefined> = []
    let unreadWrapper = false
    let at = 0
    // What stands before the command, read off the words: env's options change the folder and split a command line.
    prefixes: for (let word = words[at]; word !== undefined; word = words[at]) {
      if (/^\d*(?:[<>]|&>)/.test(word)) {
        // A redirection before the command: its target goes with it.
        at += /^\d*(?:[<>]+|&>+)&?$/.test(word) ? 2 : 1
      } else if (/^[A-Za-z_]\w*=/.test(word)) {
        if (/^GIT_(?:DIR|WORK_TREE)=/.test(word)) isElsewhere = true
        at++
      } else if (PREFIXES.has(word.replace(/^.*\//, ''))) {
        const prefix = word.replace(/^.*\//, '')
        const wrapper = PREFIXES.get(prefix)!
        const { valued, flags, long: longs, operands = 0 } = wrapper
        if (!wrapper.inShell) isChild = true
        if (wrapper.fromStdin) fromStdin = true
        const start = at
        let exec = false
        for (at++; words[at]?.startsWith('-') && words[at] !== '-';) {
          const flag = words[at++]!
          if (flag === '--') break
          const [, longName = '', attached] = /^--([^=]+)(?:=([\s\S]*))?$/.exec(flag) ?? []
          const index = flag.startsWith('--') ? -1 : [...flag.slice(1)].findIndex(ch => valued.includes(ch))
          // A strict wrapper's option it does not list: the command is left unread, and judged as an unknown one.
          const isUnread = flag.startsWith('--')
            ? longs !== undefined && !(longName in longs)
            : flags !== undefined && [...flag.slice(1, index < 0 ? undefined : index + 1)].some(ch => !flags.includes(ch))
          if (isUnread) {
            unreadWrapper = true
            at = start
            break prefixes
          }
          const cluster = flag.startsWith('--') ? '' : flag.slice(1, index < 0 ? undefined : index)
          if ((wrapper.away && [...cluster].some(ch => wrapper.away!.includes(ch))) || (prefix === 'sudo' && longName === 'login')) chdirs.push(undefined)
          if ((wrapper.exec && [...cluster].some(ch => wrapper.exec!.includes(ch))) || (wrapper.joins && longName === 'exec')) exec = true
          if (flag.startsWith('--')) {
            if (longs?.[longName]) {
              const value = attached ?? words[at++]
              if (value === undefined) break
              if (longName === 'chdir') chdirs.push(value)
              if (longName === 'split-string') words.splice(at, 0, ...shellWords(value))
            }
            continue
          }
          if (index < 0) continue
          const option = flag[index + 1]!
          const value = flag.slice(index + 2) || words[at++]
          if (value === undefined) break
          if (wrapper.chdir?.includes(option)) chdirs.push(value)
          if (wrapper.split?.includes(option)) words.splice(at, 0, ...shellWords(value))
        }
        at += operands
        if (wrapper.joins && !exec) {
          // watch runs its words joined, as a script for `sh -c`.
          const from = chdirs.length === 0 ? here : UNKNOWN
          return (await run(words.slice(at).join(' '), from, depth + 1)).hit ? HIT : { hit: false, ok: here, failed: here }
        }
      } else break
    }
    // A command named by an alias this command defined runs the alias's text, the rest of its words after it.
    const aliased = words[at] === undefined ? undefined : shellAliases.get(words[at]!)
    if (aliased !== undefined && depth < 8 && words.slice(0, at).every(word => /^[A-Za-z_]\w*=/.test(word))) {
      return simple([...words.slice(0, at), ...shellWords(aliased), ...words.slice(at + 1)], here, depth + 1, isChildAlready)
    }
    const name = words[at]?.replace(/^.*\//, '')
    const args = words.slice(at + 1)
    // Where the command itself runs: here, or where its wrappers took it.
    const from: Dirs = chdirs.length === 0 ? here
      : new Set([...here].map(dir => chdirs.reduce<string | undefined>((current, path) => directoryAfter(current, path), dir)))
    const end = (ok: Dirs, failed: Dirs = here): End => ({ hit: false, ok, failed })
    if (name === undefined) return end(here, here)
    // A command named by a variable, a substitution or a placeholder (`$GIT commit`, `{}` under xargs) is any command.
    if (/[$`{}*?]/.test(words[at]!) || words[at] === '_') {
      return mayCommit(words.slice(at)) || (fromStdin && NAMES_COMMIT.test(command)) ||
        (words[at] === '_' && namesDirectCommit.test(command)) ? HIT : end(here)
    }
    if (!isChild && (name === 'cd' || name === 'pushd' || name === 'popd')) {
      // `cd -`, `cd` alone and `popd` go somewhere this cannot follow.
      const to = name === 'popd' ? undefined : args.find(arg => arg !== '--' && !/^-[LPe@]+$/.test(arg))
      return end(new Set([...here].map(dir => to === undefined || to === '-' ? undefined : directoryAfter(dir, to))))
    }
    if (!isChild && (name === 'exit' || name === 'return')) return end(new Set(), new Set())
    if (name === 'git' || /^git-./.test(name)) {
      const gitArgs = name === 'git' ? args : [name.slice(4), ...args]
      return await git(gitArgs, from, isElsewhere, fromStdin, depth) ? HIT : end(here)
    }
    if (SHELLS.test(name)) {
      // `sh -c '…'` runs its program as a script of its own, with the c anywhere in a cluster (`-ec`, `-ce`), and may
      // run the operands after it as `$1`. Options that take a value (`-o pipefail`) are read with it.
      const shell = shellLaunch(args)
      if (shell.code !== undefined) {
        for (const script of [shell.code, ...shell.operands]) if ((await run(script, from, depth + 1)).hit) return HIT
        return end(here)
      }
      // A here-string is the script: `sh <<< 'git status'`.
      if (shell.stdin && shell.fed !== undefined) return (await run(shell.fed, from, depth + 1)).hit ? HIT : end(here)
      // A shell reading its script from a pipe, a heredoc or its input, or from a file, runs text this does not follow.
      if (fromStdin || shell.stdin || args.some(arg => arg.startsWith('<'))) return NAMES_COMMIT.test(command) ? HIT : end(here)
      // A script that a substitution or a variable names (`bash <(…)`, `sh "$F"`) is text this does not have.
      if (shell.file === '_' || /[$`]/.test(shell.file ?? '')) return NAMES_COMMIT.test(command) ? HIT : end(here)
      return end(here)
    }
    if (name === 'eval') {
      // eval runs its words in this shell: a cd there moves it. Words a variable fills in may be any command.
      if ((/[$`]/.test(args.join(' ')) || args.includes('_')) && (mayCommit(args) || NAMES_COMMIT.test(command))) return HIT
      const ran = await run(args.join(' '), from, depth + 1)
      return ran.hit ? HIT : isChild ? end(here) : ran
    }
    if (name === 'find') {
      // What -exec and -ok run, and what -execdir and -okdir run in each found file's folder.
      for (let i = 0; i < args.length; i++) {
        const action = /^-(exec|execdir|ok|okdir)$/.exec(args[i]!)?.[1]
        if (!action) continue
        const stop = args.findIndex((arg, j) => j > i && (arg === ';' || arg === '+'))
        const ran = await simple(args.slice(i + 1, stop < 0 ? undefined : stop), action.endsWith('dir') ? UNKNOWN : from, depth + 1, true)
        if (ran.hit) return HIT
        i = stop < 0 ? args.length : stop
      }
      return end(here)
    }
    if (name === 'source' || name === '.') {
      // A script read into this shell may go anywhere, and what it runs is not on this line. One a substitution
      // makes (`. <(…)`) runs what the line itself wrote: refused when it names a commit.
      if (args.some(arg => arg === '_' || /[$`]/.test(arg)) && NAMES_COMMIT.test(command)) return HIT
      return end(union(here, UNKNOWN), union(here, UNKNOWN))
    }
    if (name === 'trap') {
      // A trap's script runs later, from wherever the shell is then.
      const script = args.find(arg => !arg.startsWith('-'))
      if (script !== undefined && (await run(script, UNKNOWN, depth + 1)).hit) return HIT
      return end(here)
    }
    if (functions.has(name)) return end(union(here, UNKNOWN), union(here, UNKNOWN))
    if (name === 'alias') {
      for (const arg of args) {
        const [, alias, value] = /^([^=\s]+)=([\s\S]*)$/.exec(arg) ?? []
        if (alias !== undefined) shellAliases.set(alias, value!)
      }
      return NAMES_COMMIT.test(`git ${args.join(' ')}`) ? HIT : end(here)
    }
    // A command this does not know (or a strict wrapper whose flag could not be read) that runs git or a shell after
    // it is a commit when it names one, when its shell script commits, or when its further words come from its input.
    if (!INERT.has(name)) {
      if (/^(?:python\d*|perl|node|ruby|osascript|su|tmux)$/.test(name) &&
          (name === 'tmux' || args.some(arg => /^-[A-Za-z]*[ce]/.test(arg))) &&
          // Inline code names git and the subcommand any way it likes: `git commit`, or `['git', 'commit']`.
          args.some(arg => NAMES_COMMIT.test(arg))) return HIT
      if ((unreadWrapper || RUNNERS.has(name)) && NAMES_COMMIT.test(words.slice(at).join(' '))) return HIT
      const runsGit = words.slice(at + 1).some(word => /^git(?:-.+)?$/.test(word.replace(/^.*\//, '')))
      if (runsGit && (fromStdin || NAMES_COMMIT.test(words.slice(at).join(' ')))) return HIT
      for (let j = at + 1; j < words.length; j++) {
        if (!SHELLS.test(words[j]!.replace(/^.*\//, ''))) continue
        const shell = shellLaunch(words.slice(j + 1))
        if (shell.code !== undefined) {
          for (const script of [shell.code, ...shell.operands]) if ((await run(script, UNKNOWN, depth + 1)).hit) return HIT
        } else if (shell.stdin && shell.fed !== undefined) {
          if ((await run(shell.fed, UNKNOWN, depth + 1)).hit) return HIT
        } else if ((fromStdin || shell.stdin || shell.file === '_' || /[$`]/.test(shell.file ?? '')) && NAMES_COMMIT.test(command)) {
          return HIT
        }
      }
    }
    return end(here)
  }
  // The compound commands open at a point of the script: what each restores or joins when it closes.
  type Frame = {
    kind: '(' | '{' | 'if' | 'loop' | 'case'
    entry: Dirs
    // Run as a process of its own (a pipeline stage, `&`, a function body): nothing inside moves the shell.
    isApart: boolean
    isFunction?: boolean
    pipeStart: Dirs
    listStart: Dirs
    // What a `&&` or `||` before it skips to: joined after the whole compound, not after its first command.
    carryOk: Dirs
    carryFailed: Dirs
    // if: where the condition failed, and where each branch ended. case: where each arm ended.
    condFailed?: Dirs
    ends: Dirs[]
    hasElse?: boolean
    state?: 'pattern' | 'body'
    fall?: Dirs
    // loop: the point the loop started, to read it again from where its body left the shell.
    restart?: Restart
  }
  type State = { op: Statement['next']; ok: Dirs; failed: Dirs; listStart: Dirs; pipeStart: Dirs; carryOk: Dirs; carryFailed: Dirs }
  type Restart = { index: number; rest: string; here: Dirs; state: State; frames: Frame[]; key: string }
  const copyFrames = (frames: Frame[]) => frames.map(frame => ({ ...frame, ends: [...frame.ends] }))
  // Reads a script from `from`: whether it commits, and where it may leave the shell when it ends well or badly.
  const run = async (script: string, from: Dirs, depth = 0): Promise<End> => {
    if (depth > 8) return NAMES_COMMIT.test(script) ? HIT : { hit: false, ok: union(from, UNKNOWN), failed: union(from, UNKNOWN) }
    const statements = scanShell(script)
    // ponytail: depth and passes bound a script that nests or loops without end; past them the script is refused when it names a commit
    let s: State = { op: ';', ok: from, failed: new Set(), listStart: from, pipeStart: from, carryOk: new Set(), carryFailed: new Set() }
    let frames: Frame[] = []
    // Each loop's passes so far: a loop is read again while its body leaves the shell somewhere new.
    const passes = new Map<string, number>()
    let resume: { rest: string; here: Dirs } | undefined
    let isFunctionNext = false
    statements: for (let index = 0; index < statements.length; index++) {
      const { text, plain = text, inner = [], next, unread } = statements[index]!
      // A substitution that never closes runs what this cannot list: refused when the script names a commit.
      if (unread && NAMES_COMMIT.test(script)) return HIT
      let here: Dirs
      let rest: string
      if (resume) {
        ({ rest, here } = resume)
        resume = undefined
      } else {
        const { op } = s
        here = op === '&&' ? s.ok : op === '||' ? s.failed : op === '|' ? s.pipeStart : union(s.ok, s.failed)
        if (op !== '|' && op !== '&&' && op !== '||') s.listStart = here
        if (op !== '|') {
          s.pipeStart = here
          s.carryOk = op === '||' ? s.ok : new Set()
          s.carryFailed = op === '&&' ? s.failed : new Set()
        }
        rest = plain.trim()
      }
      const isPiped = s.op === '|' || next === '|'
      let negated = false
      // Where this statement leaves the shell, set by a close or by its command.
      let okNext = here
      let failedNext = here
      // Whether this statement opened or closed a compound: then its command is not the pipeline stage itself.
      let framed = false
      const open = (kind: Frame['kind'], extra: Partial<Frame> = {}) => {
        framed = true
        const isFunction = isFunctionNext && (kind === '(' || kind === '{')
        frames.push({ kind, entry: here, isApart: s.op === '|' || isFunction, isFunction, pipeStart: s.pipeStart, listStart: s.listStart,
          carryOk: s.carryOk, carryFailed: s.carryFailed, ends: [], ...extra })
        s.carryOk = s.carryFailed = new Set()
        isFunctionNext = false
        // A function's body runs when it is called, from wherever that is.
        if (isFunction) here = UNKNOWN
        okNext = failedNext = here
      }
      // Closes the innermost frame of `kind`; where the shell is after it.
      const shut = (frame: Frame, after: Dirs) => {
        framed = true
        frames.splice(frames.lastIndexOf(frame), 1)
        const isApart = frame.isApart || frame.kind === '(' || next === '|' || next === '&'
        here = okNext = failedNext = isApart ? frame.entry : after
        s.pipeStart = frame.pipeStart
        s.listStart = frame.listStart
        s.carryOk = frame.carryOk
        s.carryFailed = frame.carryFailed
      }
      const top = () => frames.at(-1)
      let keyword: RegExpExecArray | null
      lead: for (;;) {
        const frame = top()
        if (frame?.kind === 'case' && frame.state === 'pattern') {
          if (/^esac(?=[\s;&|)<>]|$)/.test(rest)) {
            rest = rest.slice(4).trimStart()
            shut(frame, union(...frame.ends, frame.fall ?? new Set(), frame.entry))
            continue
          }
          if (rest === '') break
          const pattern = CASE_PATTERN.exec(rest)
          // A case this cannot read: refused when the script names a commit anywhere, as a failed check is.
          if (!pattern) return NAMES_COMMIT.test(script) ? HIT : { hit: false, ok: UNKNOWN, failed: UNKNOWN }
          rest = rest.slice(pattern[0].length)
          frame.state = 'body'
          here = okNext = failedNext = union(frame.entry, frame.fall ?? new Set())
          frame.fall = undefined
          continue
        }
        if (/^!(?=\s|$)/.test(rest)) {
          negated = !negated
          rest = rest.slice(1).trimStart()
        } else if ((keyword = /^(?:time(?:\s+-p)?|coproc(?:\s+[A-Za-z_]\w*(?=\s*[({]))?)(?=\s+(?:[({]|(?:if|while|until|for|select|case)\b))\s*/.exec(rest))) {
          // `time` and `coproc` before a compound command; a coproc runs apart.
          rest = rest.slice(keyword[0].length)
          if (keyword[0].startsWith('coproc')) s.op = '|'
        } else if ((keyword = /^(?:function\s+([A-Za-z_][\w.:-]*)(?:\s*\(\s*\))?|([A-Za-z_][\w.:-]*)\s*\(\s*\))\s*/.exec(rest))) {
          // A function's body is read as it is defined, from a folder this cannot tell; a call may move the shell.
          functions.add(keyword[1] ?? keyword[2]!)
          isFunctionNext = true
          rest = rest.slice(keyword[0].length)
        } else if (rest.startsWith('(')) {
          rest = rest.slice(1).trimStart()
          open('(')
        } else if (/^\{(?=\s|$)/.test(rest)) {
          rest = rest.slice(1).trimStart()
          open('{')
        } else if ((keyword = /^(if|while|until|for|select)(?=[\s;(]|$)\s*/.exec(rest))) {
          const kind = keyword[1] === 'if' ? 'if' : 'loop'
          const key = `${index}:${rest.length}`
          const restart: Restart | undefined = kind === 'loop' ? { index, rest, here, state: { ...s }, frames: copyFrames(frames), key } : undefined
          rest = rest.slice(keyword[0].length)
          open(kind, restart ? { restart } : {})
          // `for x in a b` names no command; what its words substitute is read with the statement.
          if (keyword[1] === 'for' || keyword[1] === 'select') rest = ''
        } else if ((keyword = /^case\s+(?:"[^"]*"|'[^']*'|\S+)\s+in(?=\s|$)\s*/.exec(rest))) {
          rest = rest.slice(keyword[0].length)
          open('case', { state: 'pattern' })
        } else if ((keyword = /^(then|elif|else|do)(?=[\s;({!]|$)\s*/.exec(rest))) {
          const word = keyword[1]!
          if (word === 'do' ? frame?.kind !== 'loop' : frame?.kind !== 'if') break
          rest = rest.slice(keyword[0].length)
          if (word === 'then') {
            frame!.condFailed = s.failed
            here = s.ok
          } else if (word === 'do') {
            here = union(s.ok, s.failed)
          } else {
            frame!.ends.push(union(s.ok, s.failed))
            here = frame!.condFailed ?? frame!.entry
            if (word === 'else') frame!.hasElse = true
          }
          okNext = failedNext = here
        } else if ((keyword = /^(fi|done|esac|\})(?=[\s;&|)<>]|$)\s*/.exec(rest))) {
          const word = keyword[1]!
          const kind = word === 'fi' ? 'if' : word === 'done' ? 'loop' : word === 'esac' ? 'case' : '{'
          if (frame?.kind !== kind) break
          rest = rest.slice(keyword[0].length)
          const reached = union(s.ok, s.failed)
          if (kind === 'if') {
            shut(frame, union(...frame.ends, reached, frame.hasElse ? new Set() : frame.condFailed ?? frame.entry))
          } else if (kind === 'case') {
            shut(frame, union(...frame.ends, frame.state === 'body' ? reached : new Set(), frame.fall ?? new Set(), frame.entry))
          } else if (kind === '{') {
            if (frame.isFunction) shut(frame, frame.entry)
            else {
              shut(frame, reached)
              if (!(frame.isApart || next === '|' || next === '&')) [okNext, failedNext] = [s.ok, s.failed]
            }
          } else {
            const restart = frame.restart!
            const seen = union(restart.here, reached)
            const pass = passes.get(restart.key) ?? 0
            if (seen.size > restart.here.size && pass < 6) {
              // The body left the shell somewhere new: the loop is read again from there. Past a few passes
              // (a relative cd in the loop goes deeper each time) it is read from a folder this cannot tell.
              passes.set(restart.key, pass + 1)
              s = { ...restart.state }
              frames = copyFrames(restart.frames)
              resume = { rest: restart.rest, here: pass < 4 ? seen : UNKNOWN }
              index = restart.index - 1
              continue statements
            }
            shut(frame, seen)
          }
        } else break lead
      }
      // What a substitution runs, it runs from here, and keeps its own cd to itself.
      for (const body of inner) if ((await run(body, here, depth + 1)).hit) return HIT
      const { text: commandText, closes } = closesAfter(rest)
      if (commandText.trim() !== '') {
        const ran = await simple(shellWords(commandText), here, depth, (isPiped && !framed) || next === '&')
        if (ran.hit) return HIT
        okNext = ran.ok
        failedNext = ran.failed
      }
      if (negated) [okNext, failedNext] = [failedNext, okNext]
      // A subshell's close: the shell is where it was before it opened.
      for (let n = 0; n < closes; n++) {
        const frame = frames.findLast(one => one.kind === '(')
        if (!frame) break
        while (top() !== frame) frames.pop()
        shut(frame, frame.entry)
      }
      if (isPiped && !framed) okNext = failedNext = here
      if (next !== '|') {
        okNext = union(okNext, s.carryOk)
        failedNext = union(failedNext, s.carryFailed)
      }
      if (next === '&') {
        okNext = s.listStart
        failedNext = new Set()
      }
      const frame = top()
      if ((next === ';;' || next === ';&') && frame?.kind === 'case' && frame.state === 'body') {
        frame.ends.push(union(okNext, failedNext))
        if (next === ';&') frame.fall = union(okNext, failedNext)
        frame.state = 'pattern'
      }
      s.ok = okNext
      s.failed = failedNext
      s.op = next === '&' || next === ';;' || next === ';&' ? ';' : next
    }
    return { hit: false, ok: s.ok, failed: s.failed }
  }
  return (await run(command, new Set([cwd]))).hit
}

// pgrep's options that take a value of their own: the word after one is no pattern and no flag.
const PGREP_VALUED = /^-[A-Za-z]*[dFgGPstuU]$/
const assignment = /^([A-Za-z_]\w*)=([\s\S]*)$/
const variableWord = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/

function possibleCommands(command: string) {
  const statements = scriptsRun(command).flatMap(script => scanShell(script).map(statement => ({
    ...statement, script, words: withoutRedirects(shellWords(unwrap(statement.text).text)).words,
  })))
  const variables = new Map<string, string>()
  for (const { words } of statements) {
    for (const word of words[0] === 'export' ? words.slice(1) : words) {
      const match = assignment.exec(word)
      if (!match) break
      variables.set(match[1]!, match[2]!)
    }
  }
  return { statements, expand: (word: string) => {
    const match = variableWord.exec(word)
    return match ? variables.get(match[1] ?? match[2]!) ?? word : word
  } }
}

function executableIndex(words: readonly string[]): number {
  let at = 0
  while (at < words.length) {
    const name = words[at]!.replace(/^.*\//, '')
    if (assignment.test(words[at]!)) { at++; continue }
    const wrapper = PREFIXES.get(name)
    if (!wrapper || wrapper.joins) break
    for (at++; words[at]?.startsWith('-');) {
      const flag = words[at++]!
      if (flag === '--') break
      if (flag.startsWith('--')) {
        if (wrapper.long?.[flag.slice(2)] === true) at++
        continue
      }
      const valueAt = [...flag.slice(1)].findIndex(ch => wrapper.valued.includes(ch))
      if (valueAt >= 0 && valueAt + 2 === flag.length) at++
    }
    at += wrapper.operands ?? 0
  }
  return at
}

/**
 * Whether a command waits (a loop or a sleep) on a `pgrep -f` that is not exact (`-x`). Such a pattern matches any
 * command line that contains it, so a wait for `xcodebuild` never ends while an `xcodebuildmcp` server runs.
 * Read off the words of every script the command runs. A wait is a `sleep` run as a command or a statement that
 * opens a loop, not the word in an argument. `-f` counts wherever it stands; `-x` only before the pattern, so one in
 * the pattern, in a comment or in a later command excuses nothing.
 */
export function waitsOnLooseMatch(command: string): boolean {
  if (!/\b(?:sleep|while|until)\b/.test(command)) return false
  let waits = false
  let loose = false
  const { statements, expand } = possibleCommands(command)
  for (const { text, words } of statements) {
    const at = executableIndex(words)
    const name = expand(words[at] ?? '').replace(/^.*\//, '')
    if (name === 'sleep' || /^\s*(?:while|until)\b/.test(text)) waits = true
    if (name === 'pgrep' || name === 'pkill') {
      let full = false
      let exact = false
      let isPatternSeen = false
      for (let i = at + 1; i < words.length && !words[i]!.startsWith('#'); i++) {
        const word = words[i]!
        if (word === '--') break
        if (isPatternSeen || !/^-./.test(word)) {
          isPatternSeen = true
          continue
        }
        const flags = word === '--full' ? 'f' : word === '--exact' ? 'x' : word.startsWith('--') ? '' : word.slice(1)
        if (flags.includes('f')) full = true
        if (flags.includes('x') && !isPatternSeen) exact = true
        if (PGREP_VALUED.test(word) || /^--(?:delimiter|pidfile|pgroup|group|session|terminal|euid|uid)$/.test(word)) i++
      }
      if (full && !exact) loose = true
    }
  }
  return waits && loose
}

// The board commands a member may type in Bash: reading, and its own posts and reports, as the board tool takes
// them. Those that name a member name itself.
const MEMBER_READS = new Set(['show', 'status', 'plan', 'attention', 'tail'])
const MEMBER_OWN = new Set(['read', 'post', 'ready', 'revise', 'sync'])
/** Whether WORD's last path part is a glob that FILE's name matches: `board.p?`, `boar*`, `[b]oard.py`. */
function globNames(word: string, file: string): boolean {
  const base = word.replace(/^.*\//, '')
  if (!/[*?[]/.test(base)) return false
  const pattern = base.replace(/\[!?([^\]]*)\]|[.+^${}()|\\]|[*?]/g, (part, set: string | undefined) =>
    set !== undefined ? `[${part[1] === '!' ? '^' : ''}${set.replace(/\\/g, '\\\\')}]` : part === '*' ? '.*' : part === '?' ? '.' : `\\${part}`)
  try {
    return new RegExp(`^${pattern}$`).test(file)
  } catch {
    return true // a pattern this cannot read may name the file
  }
}

/**
 * Why a member's Bash command acts as another or as the coordinator, or undefined. Read off every script the command
 * runs (its substitutions, `sh -c`, `eval`), through `cd …&&`, env prefixes and python's flags. A board or verify
 * command whose subcommand or name a variable, a substitution or a wrapper hides is refused, not guessed.
 */
export function actsAsAnother(command: string, name: string, member: Roster[string]): string | undefined {
  const isVerifier = member.role === 'verifier'
  const unread = (script: string) => `a ${script} command is checked only when its subcommand and name are typed plainly: no wrapper, variable or substitution in them`
  const { statements, expand } = possibleCommands(command)
  for (const { text, script, unread: isUnread } of statements) {
    // A substitution that never closes runs what this cannot list.
    if (isUnread && /\b(?:board|verify)\.py\b/.test(script)) return unread(/\bboard\.py\b/.test(script) ? 'board' : 'verify')
    const words = shellWords(unwrap(text).text)
    const call = boardCalls(text)[0]
    const atCommand = executableIndex(words)
    for (const target of ['board', 'verify']) {
      const file = `${target}.py`
      if (launches(words, file, command)) continue
      const expanded = words.flatMap((word, index) => {
        const value = expand(word)
        if (index === atCommand && value !== word && /\s/.test(value)) return shellWords(value)
        return globNames(value, file) ? file : value
      })
      if (launches(expanded, file)) return unread(target)
    }
    // A board command typed plainly, run so that more may follow it (`python3 -i`), runs what this cannot read.
    if (call && launches(words, 'board.py', command) === 'other') return unread('board')
    if (call) {
      if (MEMBER_READS.has(call.action)) continue
      const own = MEMBER_OWN.has(call.action) && !(isVerifier && call.action !== 'read' && call.action !== 'post')
      const named = withoutRedirects(shellWords(call.rest)).words.slice(1).find(word => !word.startsWith('-'))?.replace(/^@/, '').toLowerCase()
      if (!own) return `the board's ${call.action} is the coordinator's${isVerifier && MEMBER_OWN.has(call.action) ? ', and a verifier reports with post' : ''}`
      if (named !== name) return `the board's ${call.action} names @${named ?? '?'}, and @${name} acts only as itself`
    } else if (launches(words, 'board.py', command)) return unread('board')
    const verify = launches(words, 'verify.py', command)
    if (!verify) continue
    const cleanWords = withoutRedirects(words).words
    const at = cleanWords.findIndex(word => /(?:^|\/)verify\.py$/.test(word))
    // Run some other way (python -c, a module, a program from its input), its words are not the ones it gets.
    if (verify === 'other' || at < 0) return unread('verify')
    const action = cleanWords.slice(at + 3).find(word => !word.startsWith('-'))
    if (action === undefined || !['prepare', 'test', 'accept', 'commit', 'recover-index'].includes(action)) return unread('verify')
    // A verifier tests a candidate under its own name; preparing, accepting and committing candidates is the coordinator's.
    let tester: string | undefined
    if (action === 'test') {
      const positionals: string[] = []
      for (let i = cleanWords.indexOf(action, at + 3) + 1; i < cleanWords.length; i++) {
        const word = cleanWords[i]!
        if (word === '--') {
          positionals.push(...cleanWords.slice(i + 1))
          break
        }
        if (word === '--timeout') {
          i++
          continue
        }
        if (word.startsWith('-')) continue
        positionals.push(word)
      }
      tester = positionals[1]
    }
    if (!isVerifier || action !== 'test') return `verify.py ${action} is ${action === 'test' ? "a verifier's" : "the coordinator's"}`
    if (tester?.replace(/^@/, '').toLowerCase() !== name) return `verify.py test names @${tester ?? '?'}, and @${name} tests only as itself`
  }
  return undefined
}

