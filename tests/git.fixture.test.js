const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {collectGitScope}=require('../src/execution/git.ts');

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
    fs.writeFileSync(path.join(sub,'new file.txt'),'UNTRACKED_CONTENT_ŻÓŁĆ\n');fs.writeFileSync(path.join(sub,'binary.bin'),Buffer.from([0,1,2]));
    fs.writeFileSync(path.join(sub,'too-large.txt'),'x'.repeat(256*1024+1));
    const work=await collectGitScope('uncommitted',sub);
    for(const text of ['staged change','unstaged change','UNTRACKED_CONTENT_ŻÓŁĆ','Binary file omitted','oversized file'])assert.ok(work.diff.includes(text),text);
    assert.ok(!work.diff.includes('OUTSIDE_'));
    const staged=await collectGitScope('staged',sub);assert.ok(staged.diff.includes('staged change'));assert.ok(!staged.diff.includes('unstaged change'));assert.ok(!staged.diff.includes('UNTRACKED_CONTENT'));
    for(const [scope,type] of [[sha,'commit'],['fixture-base','branch'],['fixture-base..HEAD','range'],['HEAD','commit']]) {
      const result=await collectGitScope(scope,sub);assert.equal(result.type,type);assert.ok(result.diff.includes('committed change'));assert.ok(!result.diff.includes('OUTSIDE_'));
    }
    await assert.rejects(collectGitScope('--output=bad',sub),/Validation/);
    for(let i=0;i<18;i++)fs.writeFileSync(path.join(sub,`budget-${i}.txt`),'😀'.repeat(60000));
    const bounded=await collectGitScope('uncommitted',sub);
    assert.ok(Buffer.byteLength(bounded.diff)<=3*1024*1024);assert.match(bounded.diff,/budget|Incomplete snapshot/);
    fs.writeFileSync(path.join(sub,'large.txt'),'large diff line\n'.repeat(350000));git('add','nested/large.txt');
    const largeStaged=await collectGitScope('staged',sub);
    assert.ok(Buffer.byteLength(largeStaged.diff)<=3*1024*1024);assert.match(largeStaged.diff,/Incomplete snapshot/);
    git('commit','-qm','large diff');
    for(const scope of ['HEAD','fixture-base..HEAD','fixture-base']) {
      const large=await collectGitScope(scope,sub);
      assert.ok(Buffer.byteLength(large.diff)<=3*1024*1024,scope);assert.match(large.diff,/Incomplete snapshot/);
      assert.ok(Buffer.byteLength('[TASK: CODE REVIEW & AUDIT]\nScope: '+large.label+'\nGuidelines: Review correctness.\nDIFF:\n'+large.diff)<4*1024*1024);
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
