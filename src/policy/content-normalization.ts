/**
 * Remove the sequential `N<TAB>` prefixes emitted by agent file-reading tools.
 * Any missing, malformed, or non-sequential line leaves the input untouched.
 */
export function unwrapSequentialLineNumbers(text: string): string {
  const lines = text.split(/\r?\n/);
  const trailingEmpty = lines.at(-1) === '';
  const contentLines = trailingEmpty ? lines.slice(0, -1) : lines;
  if (contentLines.length === 0) return text;

  const unwrapped: string[] = [];
  for (let index = 0; index < contentLines.length; index += 1) {
    const match = /^(\d+)\t(.*)$/.exec(contentLines[index]!);
    if (!match || Number(match[1]) !== index + 1) return text;
    unwrapped.push(match[2]!);
  }
  return `${unwrapped.join('\n')}${trailingEmpty ? '\n' : ''}`;
}