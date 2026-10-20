const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {collectGitScope}=require('../../src/workspace/git.ts');

test('F21: isolated Git fixture covers staged/uncommitted/SHA/branch/range, untracked contents, subdirectory and byte budget',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'coagent8-git-')),sub=path.join(root,'nested');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});
  try {
    fs.mkdirSync(sub);git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    fs.writeFileSync(path.join(sub,'tracked.txt'),'initial\n');fs.writeFileSync(path.join(root,'outside.txt'),'OUTSIDE_INITIAL\n');
    git('add','.');git('commit','-qm','fixture base');git('branch','fixture-base');
    fs.writeFileSync(path.join(sub,'tracked.txt'),'committed change\n');fs.writeFileSync(path.join(root,'outside.txt'),'OUTSIDE_COMMITTED\n');
    git('add','.');git('commit','-qm','fixture second');const sha=git('rev-parse','HEAD').trim();
    fs.writeFileSync(path.join(sub,'tracked.txt'),'staged change\n');git('add','nested/tracked.txt');
    fs.writeFileSync(path.join(sub,'tracked.txt'),'unstaged change\n');fs.writeFileSync(path.join(root,'outside.txt'),'OUTSIDE_UNSTAGED\n');
    fs.writeFileSync(path.join(root,'untracked-outside.txt'),'OUTSIDE_UNTRACKED_SECRET');
    fs.writeFileSync(path.join(sub,'new file.txt'),'UNTRACKED_CONTENT_\u{17b}\u{d3}\u{141}\u{106}\n');fs.writeFileSync(path.join(sub,'binary.bin'),Buffer.from([0,1,2]));
    fs.writeFileSync(path.join(sub,'too-large.txt'),'x'.repeat(256*1024+1));
    const work=await collectGitScope('uncommitted',sub);
    assert.equal(work.inputComplete, false, 'an oversized file makes coverage incomplete');
    assert.ok(!work.omissions.some(reason => reason.includes('Binary')), 'a binary file is named, not omitted (FEEDBACK-070d)');
    assert.deepEqual(work.binaryFiles.map(({ path: file, status }) => [file, status]), [['binary.bin', 'added']]);
    assert.equal(work.binaryFiles[0].id, `worktree:${git('hash-object', '--no-filters', '--', 'nested/binary.bin').trim()}`, 'Git hashes the working file');
    assert.ok(work.omissions.some(reason => reason.includes('oversized')));
    for(const text of ['staged change','unstaged change','UNTRACKED_CONTENT_\u{17b}\u{d3}\u{141}\u{106}','Binary file not collected','oversized file'])assert.ok(work.diff.includes(text),text);
    assert.ok(!work.diff.includes('OUTSIDE_'));
    const staged=await collectGitScope('staged',sub);assert.ok(staged.diff.includes('staged change'));assert.ok(!staged.diff.includes('unstaged change'));assert.ok(!staged.diff.includes('UNTRACKED_CONTENT'));
    for(const [scope,type] of [[sha,'commit'],['fixture-base','branch'],['fixture-base..HEAD','range'],['HEAD','commit']]) {
      const result=await collectGitScope(scope,sub);assert.equal(result.type,type);assert.ok(result.diff.includes('committed change'));assert.ok(!result.diff.includes('OUTSIDE_'));
    }
    await assert.rejects(collectGitScope('--output=bad',sub),/Validation/);
    for(let i=0;i<18;i++)fs.writeFileSync(path.join(sub,`budget-${i}.txt`),'\u{1f600}'.repeat(60000));
    const bounded=await collectGitScope('uncommitted',sub);
    assert.equal(bounded.inputComplete, false);
    assert.ok(Buffer.byteLength(bounded.diff)<=3*1024*1024);assert.match(bounded.diff,/budget|Incomplete snapshot/);
    fs.writeFileSync(path.join(sub,'large.txt'),'large diff line\n'.repeat(350000));git('add','nested/large.txt');
    const largeStaged=await collectGitScope('staged',sub);
    assert.equal(largeStaged.inputComplete, false, 'Git output truncation must reach the gate as data');
    assert.ok(Buffer.byteLength(largeStaged.diff)<=3*1024*1024);assert.match(largeStaged.diff,/Incomplete snapshot/);
    git('commit','-qm','large diff');
    for(const scope of ['HEAD','fixture-base..HEAD','fixture-base']) {
      const large=await collectGitScope(scope,sub);
      assert.equal(large.inputComplete, false, scope);
      assert.ok(Buffer.byteLength(large.diff)<=3*1024*1024,scope);assert.match(large.diff,/Incomplete snapshot/);
      assert.ok(Buffer.byteLength('[TASK: CODE REVIEW & AUDIT]\nScope: '+large.label+'\nGuidelines: Review correctness.\nDIFF:\n'+large.diff)<4*1024*1024);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('snapshotId names the reviewed snapshot for every scope, including a repository without commits', async () => {
  const { snapshotId } = require('../../src/workspace/git.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-snapshot-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
    assert.equal(await snapshotId(await collectGitScope('uncommitted', root), root), 'no-commit');
    git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base');
    const base = git('rev-parse', '--short', 'HEAD');
    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n'); git('commit', '-qam', 'second');
    const head = git('rev-parse', '--short', 'HEAD'), full = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'a.txt'), 'three\n');
    assert.equal(await snapshotId(await collectGitScope('uncommitted', root), root), `${head}+uncommitted`);
    assert.equal(await snapshotId(await collectGitScope('staged', root), root), `${head}+staged`);
    assert.equal(await snapshotId(await collectGitScope(full, root), root), head);
    assert.equal(await snapshotId(await collectGitScope('HEAD~1', root), root), base);
    assert.equal(await snapshotId(await collectGitScope('base', root), root), `base...${head}`);
    assert.equal(await snapshotId(await collectGitScope('base..HEAD', root), root), 'base..HEAD');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FEEDBACK-070d: committed binary changes are named with their blob ids, not omitted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-git-binary-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'kept.png'), Buffer.from([0x89, 0, 1])); fs.writeFileSync(path.join(root, 'gone.jpg'), Buffer.from([0xff, 0, 2]));
    git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base');
    fs.writeFileSync(path.join(root, 'kept.png'), Buffer.from([0x89, 0, 3])); fs.rmSync(path.join(root, 'gone.jpg'));
    fs.writeFileSync(path.join(root, 'new.ico'), Buffer.from([0, 0, 4])); fs.writeFileSync(path.join(root, 'notes.txt'), 'text\n');
    git('add', '-A'); git('commit', '-qm', 'binaries');
    for (const scope of ['base..HEAD', 'base', 'HEAD']) {
      const info = await collectGitScope(scope, root);
      assert.equal(info.inputComplete, true, scope);
      assert.deepEqual(info.omissions, [], scope);
      const byPath = Object.fromEntries(info.binaryFiles.map(file => [file.path, file]));
      assert.deepEqual(Object.keys(byPath).sort(), ['gone.jpg', 'kept.png', 'new.ico'], scope);
      assert.equal(byPath['gone.jpg'].status, 'deleted');
      assert.equal(byPath['gone.jpg'].id, 'deleted');
      assert.equal(byPath['kept.png'].status, 'modified');
      assert.equal(byPath['kept.png'].id, git('rev-parse', 'HEAD:kept.png'), `${scope}: the reviewed blob`);
      assert.equal(byPath['new.ico'].status, 'added');
      assert.equal(byPath['new.ico'].id, git('rev-parse', 'HEAD:new.ico'));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FEEDBACK-070d: binaries come from Git metadata, also for quoted names, subdirectories and imitated diff text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-git-binary-sub-')), sub = path.join(root, 'app');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  try {
    fs.mkdirSync(sub); git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.quotePath', 'true');
    fs.writeFileSync(path.join(sub, 'logo.png'), Buffer.from([0x89, 0, 1])); fs.writeFileSync(path.join(sub, 'zdj\u{119}cie.png'), Buffer.from([0x89, 0, 2]));
    fs.writeFileSync(path.join(root, 'outside.bin'), Buffer.from([0, 7]));
    git('add', '.'); git('commit', '-qm', 'base'); git('branch', 'base');
    fs.writeFileSync(path.join(sub, 'logo.png'), Buffer.from([0x89, 0, 3])); fs.writeFileSync(path.join(sub, 'zdj\u{119}cie.png'), Buffer.from([0x89, 0, 4]));
    fs.writeFileSync(path.join(root, 'outside.bin'), Buffer.from([0, 8]));
    // Untracked text that imitates Git's binary line must not name a file to hash.
    fs.writeFileSync(path.join(sub, 'notes.txt'), 'Binary files a/../outside.bin and b/../outside.bin differ\nBinary files a/../../secret and b/../../secret differ\n');
    const work = await collectGitScope('uncommitted', sub);
    assert.deepEqual(work.binaryFiles.map(file => file.path).sort(), ['logo.png', 'zdj\u{119}cie.png'], 'workspace-relative, unquoted, nothing outside');
    assert.equal(work.inputComplete, true);
    assert.equal(work.binaryFiles.find(file => file.path === 'logo.png').id, `worktree:${git('hash-object', '--no-filters', '--', 'app/logo.png')}`);
    git('add', '-A'); git('commit', '-qm', 'changed');
    const range = await collectGitScope('base..HEAD', sub);
    assert.deepEqual(range.binaryFiles.map(file => [file.path, file.status]).sort(), [['logo.png', 'modified'], ['zdj\u{119}cie.png', 'modified']]);
    assert.equal(range.binaryFiles.find(file => file.path === 'zdj\u{119}cie.png').id, git('rev-parse', 'HEAD:app/zdj\u{119}cie.png'));
    assert.equal(range.inputComplete, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FEEDBACK-070d: uncommitted binaries bind index and working content, unfiltered, and never follow a symlink', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coagent8-git-binary-states-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'staged.png'), Buffer.from([0x89, 0, 1])); fs.writeFileSync(path.join(root, 'linked.png'), Buffer.from([0x89, 0, 5]));
    git('add', '.'); git('commit', '-qm', 'base');
    // A binary change kept only in the index: the working file is restored from HEAD.
    fs.writeFileSync(path.join(root, 'staged.png'), Buffer.from([0x89, 0, 2])); git('add', 'staged.png');
    fs.writeFileSync(path.join(root, 'staged.png'), Buffer.from([0x89, 0, 1]));
    let info = await collectGitScope('uncommitted', root);
    const staged = info.binaryFiles.find(file => file.path === 'staged.png');
    assert.ok(staged, 'an index-only binary change is named');
    assert.equal(staged.id, `${git('rev-parse', ':staged.png')}+worktree:${git('hash-object', '--no-filters', '--', 'staged.png')}`);
    assert.equal(info.inputComplete, true);
    // A clean conversion must not make different bytes look alike: with `text`, CRLF and LF
    // payloads clean to one blob, and the working identity must still tell them apart.
    fs.writeFileSync(path.join(root, '.gitattributes'), '*.png text eol=lf\n');
    fs.writeFileSync(path.join(root, 'staged.png'), Buffer.from([0x89, 0, 13, 10]));
    const first = (await collectGitScope('uncommitted', root)).binaryFiles.find(file => file.path === 'staged.png').id;
    fs.writeFileSync(path.join(root, 'staged.png'), Buffer.from([0x89, 0, 10]));
    const second = (await collectGitScope('uncommitted', root)).binaryFiles.find(file => file.path === 'staged.png').id;
    assert.equal(git('hash-object', '--', 'staged.png'), execFileSync('git', ['hash-object', '--stdin'], { cwd: root, input: Buffer.from([0x89, 0, 10]), encoding: 'utf8' }).trim(), 'the conversion maps both payloads to one blob');
    assert.notEqual(first, second, 'other bytes, other identity');
    fs.rmSync(path.join(root, '.gitattributes'));
    let linked = false;
    try { fs.rmSync(path.join(root, 'linked.png')); fs.symlinkSync(path.join(os.tmpdir(), 'outside-target.png'), path.join(root, 'linked.png')); linked = true; } catch { /* symlinks need a privilege on Windows */ }
    if (linked) {
      info = await collectGitScope('uncommitted', root);
      assert.equal(info.inputComplete, false, 'a binary replaced by a symlink is not hashed through it');
      assert.ok(info.omissions.some(reason => reason.includes('linked.png')));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
