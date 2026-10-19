/** The unified diff reader that feeds the Compare detail's `DiffBlock`. */
import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../src/client/unified-diff.ts'

const TWO_FILES = [
  'diff --git a/tinyq/retry.py b/tinyq/retry.py',
  'index 1111111..2222222 100644',
  '--- a/tinyq/retry.py',
  '+++ b/tinyq/retry.py',
  '@@ -26,5 +26,5 @@ def delays(policy):',
  '     for _ in range(policy.attempts - 1):',
  '         capped = min(delay, policy.max_delay)',
  '-        yield capped + rng.uniform(0, policy.jitter * capped)',
  '+        yield capped - rng.uniform(0, policy.jitter * capped)',
  '         delay *= policy.factor',
  '     return',
  'diff --git a/tests/test_retry.py b/tests/test_retry.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/test_retry.py',
  '@@ -0,0 +1,2 @@',
  '+def test_a():',
  '+    pass',
  '',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('reads one hunk per section with the path of the file after the change', () => {
    const { hunks, binary } = parseUnifiedDiff(TWO_FILES)
    expect(binary).toEqual([])
    expect(hunks).toEqual([
      {
        path: 'tinyq/retry.py',
        oldText: [
          '    for _ in range(policy.attempts - 1):',
          '        capped = min(delay, policy.max_delay)',
          '        yield capped + rng.uniform(0, policy.jitter * capped)',
          '        delay *= policy.factor',
          '    return',
          '',
        ].join('\n'),
        newText: [
          '    for _ in range(policy.attempts - 1):',
          '        capped = min(delay, policy.max_delay)',
          '        yield capped - rng.uniform(0, policy.jitter * capped)',
          '        delay *= policy.factor',
          '    return',
          '',
        ].join('\n'),
      },
      { path: 'tests/test_retry.py', oldText: '', newText: 'def test_a():\n    pass\n' },
    ])
  })

  it('keeps several hunks of one file under its path and reads omitted counts as one line', () => {
    const { hunks } = parseUnifiedDiff([
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-one',
      '+uno',
      '@@ -9,2 +9,2 @@',
      ' keep',
      '-two',
      '+dos',
    ].join('\n'))
    expect(hunks).toEqual([
      { path: 'a.txt', oldText: 'one\n', newText: 'uno\n' },
      { path: 'a.txt', oldText: 'keep\ntwo\n', newText: 'keep\ndos\n' },
    ])
  })

  it('does not take a removed line that begins with dashes for a file header', () => {
    const { hunks } = parseUnifiedDiff([
      'diff --git a/notes.md b/notes.md',
      '--- a/notes.md',
      '+++ b/notes.md',
      '@@ -1,2 +1,1 @@',
      '--- a/other',
      ' tail',
      '',
    ].join('\n'))
    expect(hunks).toEqual([{ path: 'notes.md', oldText: '-- a/other\ntail\n', newText: 'tail\n' }])
  })

  it('names a deleted file by its diff header and a path with spaces by its new-path line', () => {
    const { hunks } = parseUnifiedDiff([
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/my notes.txt b/my notes.txt',
      '--- a/my notes.txt\t',
      '+++ b/my notes.txt\t',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n'))
    expect(hunks.map(hunk => hunk.path)).toEqual(['gone.txt', 'my notes.txt'])
  })

  it('skips the no-newline marker and reads a stripped blank context line as an empty line', () => {
    const { hunks } = parseUnifiedDiff([
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,3 +1,3 @@',
      ' first',
      '',
      '-last',
      '\\ No newline at end of file',
      '+LAST',
      '\\ No newline at end of file',
    ].join('\n'))
    expect(hunks).toEqual([{ path: 'x', oldText: 'first\n\nlast\n', newText: 'first\n\nLAST\n' }])
  })

  it('lists binary files without a hunk, and takes the rename target as the path', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/old.png b/new.png',
      'similarity index 90%',
      'rename from old.png',
      'rename to new.png',
      'Binary files a/old.png and b/new.png differ',
    ].join('\n'))
    expect(parsed).toEqual({ hunks: [], binary: ['new.png'] })
  })

  it('ends a section the Host cut short, and stops a section at a line that is no diff line', () => {
    expect(parseUnifiedDiff('diff --git a/x b/x\n@@ -1,5 +1,5 @@\n-a\n+b').hunks).toEqual([{ path: 'x', oldText: 'a\n', newText: 'b\n' }])
    expect(parseUnifiedDiff('diff --git a/x b/x\n@@ -1,3 +1,3 @@\n-a\n?odd\n+b\n').hunks).toEqual([{ path: 'x', oldText: 'a\n', newText: '' }])
  })

  it('reads text without hunks as empty', () => {
    expect(parseUnifiedDiff('')).toEqual({ hunks: [], binary: [] })
    expect(parseUnifiedDiff('diff --git a/m b/m\nold mode 100644\nnew mode 100755\n')).toEqual({ hunks: [], binary: [] })
  })
})
