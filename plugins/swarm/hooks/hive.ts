export type Mood = 'sleep' | 'forage' | 'inspect' | 'build' | 'verify' | 'relay'
export function toolMood(tool: string, command = ''): Mood {
  // The board first, by its subcommand: a post that mentions tests or reading is still a post.
  const board = tool === 'Bash' ? /\bboard\.py\S*\s+\S+\s+([a-z-]+)/.exec(command)?.[1] : undefined
  if (board) return ['read', 'show', 'status', 'plan', 'attention', 'wake', 'tail'].includes(board) ? 'inspect' : 'relay'
  if (tool === 'Bash' && /\bverify\.py\b|\b(test|pytest|vitest|jest|unittest|check|verify)\b/.test(command)) return 'verify'
  if (tool === 'Bash' && /^(?:git (?:diff|log|show|status)|cat|rg|ls|find|grep)\b/.test(command.trim())) return 'inspect'
  if (['Read','Grep','Glob','LSP','WebSearch','WebFetch'].includes(tool)) return 'inspect'
  if (['Write','Edit','MultiEdit','NotebookEdit','Bash'].includes(tool)) return 'build'
  if (['Agent','SendMessage','mcp__swarm__board'].includes(tool)) return 'relay'
  return 'forage'
}
const scenes: Record<Mood, [string,string,string]> = {
  sleep: ['M1 2h3v1H3v1H2v1h2v1H1V5h1V4h1V3H1z','0,-1','0,-2'],
  inspect: ['M3 2h4v1H3zM2 3h1v3H2zM7 3h1v3H7zM3 6h4v1H3zM7 7h2v2H7z','3,-2','-2,1'],
  build: ['M4 2h5v2H7v4H5V4H4z','2,-3','-3,0'],
  verify: ['M1 5h2v2H1zM3 7h2v2H3zM5 5h2v2H5zM7 3h2v2H7z','2,0','0,-3'],
  relay: ['M1 3h8v5H1z','5,-2','-4,2'],
  forage: ['M4 3h2v2H4zM2 5h2v2H2z','4,-3','-2,2'],
}
export function hiveArt(mood: Mood): string {
  const [prop, left, right] = scenes[mood]
  const sleeping = mood === 'sleep'
  const gesture = {
    sleep: 'translate(1px,-2px)', forage: 'translate(2px,-1px)', inspect: 'translate(2px,1px)',
    build: 'rotate(-28deg)', verify: 'scale(1.15)', relay: 'translate(12px,0)',
  }[mood]
  const move = (pair: string) => pair.split(',').map(n => n+'px').join(',')
  const bee = (x: number, y: number, kind: string) => `<g transform="translate(${x} ${y})"><g class="${kind}">
    <path class="wing" fill="var(--wing)" d="M2 0h2v2H2zM5 0h2v2H5z"/>
    <path fill="var(--honey)" d="M1 2h6v1h1v2H7v1H2V5H0V3h1z"/>
    <path fill="var(--ink)" d="M3 2h1v4H3z${sleeping?'M5 4h2v1H5z':'M6 3h1v1H6z'}"/></g></g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 22" shape-rendering="crispEdges">
    <style>svg{--wing:#99c8c8;--honey:#e9ac55;--ink:#664437;--wax:#b46b46}
    @supports(color:color(display-p3 1 0 0)){svg{--wing:color(display-p3 .61 .80 .80);--honey:color(display-p3 .94 .68 .31);--ink:color(display-p3 .40 .26 .20);--wax:color(display-p3 .72 .42 .25)}}
    @media(prefers-reduced-motion:no-preference){.left{animation:l ${sleeping?'5':'3.4'}s steps(${sleeping?1:4},end) infinite}.right{animation:r 4.8s steps(3,end) infinite}.prop{transform-box:fill-box;transform-origin:center;animation:signal 4s steps(2,end) infinite}${sleeping?'':'.wing{animation:flutter .28s steps(1,end) infinite}'}}
    @keyframes l{0%,100%{transform:translate(0,0)}48%,64%{transform:translate(${move(left)})}}
    @keyframes r{0%,100%{transform:translate(0,0)}52%,70%{transform:translate(${move(right)})}}
    @keyframes flutter{50%{transform:translateY(1px)}}@keyframes signal{0%,100%{opacity:.5}55%{opacity:1;transform:${gesture}}}
    </style><path fill="var(--wax)" d="M17 7h7v2h3v3h2v7H13v-7h2V9h2z"/>
    <path fill="var(--honey)" d="M17 8h7v2h-7zM15 11h12v2H15zM14 14h14v2H14z"/>
    <path fill="var(--ink)" d="M19 15h4v4h-4z"/>
    ${bee(sleeping?7:1,sleeping?14:12,'left')}${bee(sleeping?28:33,sleeping?14:6,'right')}
    <g transform="translate(${sleeping?27:9} 1)"><path class="prop" fill="var(--wing)" d="${prop}"/></g></svg>`
}
