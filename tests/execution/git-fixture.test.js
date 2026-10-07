const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {collectGitScope}=require('../../src/execution/git.ts');

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
    assert.equal(work.inputComplete, false, 'binary and oversized files make coverage incomplete');
    assert.ok(work.omissions.some(reason => reason.includes('Binary')));
    assert.ok(work.omissions.some(reason => reason.includes('oversized')));
    for(const text of ['staged change','unstaged change','UNTRACKED_CONTENT_\u{17b}\u{d3}\u{141}\u{106}','Binary file omitted','oversized file'])assert.ok(work.diff.includes(text),text);
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
  const { snapshotId } = require('../../src/execution/git.ts');
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
