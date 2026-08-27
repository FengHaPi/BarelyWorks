export function ArtifactDiff({ current, previous, currentLabel, previousLabel }: {
  current: string;
  previous: string;
  currentLabel: string;
  previousLabel: string;
}) {
  const currentLines = current.split(/\r?\n/u);
  const previousLines = previous.split(/\r?\n/u);
  const rows = Array.from({ length: Math.max(currentLines.length, previousLines.length) }, (_, index) => ({
    index: index + 1,
    current: currentLines[index] ?? "",
    previous: previousLines[index] ?? "",
  })).filter((row) => row.current !== row.previous);
  return <div className="af-diff">
    <div className="af-diff-head"><span>{previousLabel}</span><span>{currentLabel}</span></div>
    {rows.length ? rows.slice(0, 160).map((row) => <div className="af-diff-row" key={row.index}>
      <pre><i>-{row.index}</i>{row.previous || " "}</pre>
      <pre><i>+{row.index}</i>{row.current || " "}</pre>
    </div>) : <p className="af-empty">两版正文没有按行差异。</p>}
    {rows.length > 160 && <p className="af-muted">仅显示前 160 行差异。</p>}
  </div>;
}
