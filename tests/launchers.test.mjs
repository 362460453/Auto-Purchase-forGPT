import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, copyFile, rename, rm, access} from 'node:fs/promises';
import {execFile as callbackExecFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import net from 'node:net';
import {createHash} from 'node:crypto';
const execFile=promisify(callbackExecFile);
const root=process.env.LAUNCHER_SOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pwsh=process.env.POWERSHELL_BIN || 'pwsh';
const psAvailable=await execFile(pwsh,['-NoLogo','-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()']).then(()=>true,()=>false);
const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const exists=p=>access(p).then(()=>true,()=>false);
const git=(dir,...args)=>execFile('git',['-C',dir,...args]);
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return String(p);}
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'gpt-launcher-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const seed=join(dir,'seed'),remote=join(dir,'remote.git'),launch=join(dir,'发给用户 launchers'),project=join(dir,'项目 with spaces'),marker=join(dir,'ran.json');
 await mkdir(seed);await mkdir(launch);
 await git(seed,'init','-b','main');await git(seed,'config','user.name','Launcher test');await git(seed,'config','user.email','fixture@example.invalid');
 await writeFile(join(seed,'package.json'),JSON.stringify({name:'auto-purchase-for-gpt',type:'module'}));
 await writeFile(join(seed,'server.mjs'),'// launcher fixture\n');
 await writeFile(join(seed,'.gitignore'),'data/\n.env\n');
 const writeVersion=async value=>{
  await writeFile(join(seed,'dev.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(process.env.LAUNCHER_TEST_MARKER,JSON.stringify({version:${JSON.stringify(value)},cwd:process.cwd()}));process.exit(Number(process.env.LAUNCHER_TEST_EXIT||0));\n`);
  await git(seed,'add','.');await git(seed,'commit','-m',value);
 };
 await writeVersion('v1');await git(dir,'clone','--bare',seed,remote);
 const env={...process.env,GPT_UPGRADE_REPO_URL:pathToFileURL(remote).href,GPT_UPGRADE_PROJECT_DIR:project,LAUNCHER_TEST_MARKER:marker,PORT:await port()};
 delete env.GPT_UPGRADE_RUNTIME_DIR;
 const update=async version=>{await writeVersion(version);await git(seed,'push',remote,'main');};
 return{dir,seed,remote,launch,project,marker,env,update,version:async()=>JSON.parse(await readFile(marker,'utf8')).version};
}
async function run(kind,f,override={},scriptDirectory=f.launch){
 const source=kind==='mac'?'start-mac.command':'start-windows.ps1';
 const script=join(scriptDirectory,source);
 await copyFile(join(root,source),script);
 const env={...f.env,...override};
 // Legacy 参数传递覆盖 Windows PowerShell 5.1 的引号行为。
 const args=kind==='mac'?[script]:['-NoLogo','-NoProfile','-Command',`$PSNativeCommandArgumentPassing='Legacy'; & '${script.replaceAll("'","''")}'; exit $LASTEXITCODE`];
 try{const r=await execFile(kind==='mac'?'/bin/bash':pwsh,args,{env,cwd:f.launch,timeout:30000});return{code:0,output:r.stdout+r.stderr};}
 catch(e){return{code:e.code,output:(e.stdout||'')+(e.stderr||'')};}
}
for(const kind of ['mac','windows']){
 const skip=kind==='mac'?process.platform!=='darwin':!psAvailable;
 test(`${kind}: 单独分发后首次下载、更新且保留日志和配置`,{skip},async t=>{
  const f=await fixture(t);
  let r=await run(kind,f);assert.equal(r.code,0,r.output);assert.equal(await f.version(),'v1');
  await mkdir(join(f.project,'data'));await writeFile(join(f.project,'data','keep.txt'),'keep');await writeFile(join(f.project,'.env'),'fixture');
  await f.update('v2');r=await run(kind,f);assert.equal(r.code,0,r.output);assert.equal(await f.version(),'v2');
  assert.equal(await readFile(join(f.project,'data','keep.txt'),'utf8'),'keep');assert.equal(await readFile(join(f.project,'.env'),'utf8'),'fixture');
 });
 test(`${kind}: 本地改动、非 main 和分歧提交均保留，不强制重置`,{skip},async t=>{
  const f=await fixture(t);assert.equal((await run(kind,f)).code,0);
  await git(f.project,'config','user.name','Fixture');await git(f.project,'config','user.email','fixture@example.invalid');
  const local=await readFile(join(f.project,'dev.mjs'),'utf8');await writeFile(join(f.project,'dev.mjs'),local.replace('v1','local'));
  await f.update('v2');let r=await run(kind,f);assert.equal(r.code,0,r.output);assert.equal(await f.version(),'local');
  await git(f.project,'add','dev.mjs');await git(f.project,'commit','-m','local');
  r=await run(kind,f);assert.equal(r.code,0,r.output);assert.equal(await f.version(),'local');assert.match(r.output,/分支分歧/);
  await git(f.project,'switch','-c','fixture');r=await run(kind,f);assert.equal(r.code,0,r.output);assert.equal(await f.version(),'local');assert.match(r.output,/非 main/);
 });
 test(`${kind}: 下载失败不留半成品，更新断网时可运行已有代码`,{skip},async t=>{
  const f=await fixture(t);const missing=pathToFileURL(join(f.dir,'missing.git')).href;
  let r=await run(kind,f,{GPT_UPGRADE_REPO_URL:missing});assert.notEqual(r.code,0);assert.equal(await exists(f.project),false);assert.equal(await exists(f.marker),false);
  r=await run(kind,f);assert.equal(r.code,0,r.output);await rename(f.remote,f.remote+'.offline');
  r=await run(kind,f);assert.equal(r.code,0,r.output);assert.match(r.output,/更新失败/);assert.equal(await f.version(),'v1');
 });
 test(`${kind}: 端口占用时不更新或启动，不覆盖其他目录`,{skip},async t=>{
  const f=await fixture(t);const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  try{const r=await run(kind,f,{PORT:String(listener.address().port)});assert.notEqual(r.code,0);assert.equal(await exists(f.project),false);}finally{await new Promise(r=>listener.close(r));}
  await mkdir(f.project);await writeFile(join(f.project,'important.txt'),'keep');const r=await run(kind,f);assert.notEqual(r.code,0);assert.equal(await readFile(join(f.project,'important.txt'),'utf8'),'keep');
 });
 test(`${kind}: 本机项目目录直接使用、服务失败透传退出码`,{skip},async t=>{
  const f=await fixture(t);assert.equal((await run(kind,f)).code,0);
  const r=await run(kind,f,{GPT_UPGRADE_PROJECT_DIR:'',LAUNCHER_TEST_EXIT:'7'},f.project);
  assert.equal(r.code,7,r.output);assert.equal(await f.version(),'v1');
  assert.equal(await exists(join(f.project,kind==='mac'?'start-mac.command':'start-windows.ps1')),true);
 });
}

test('Windows 文件编码适合 PowerShell 5.1，BAT 只调用同目录配套脚本',async()=>{
 const ps=await readFile(join(root,'start-windows.ps1'));assert.deepEqual([...ps.subarray(0,3)],[239,187,191]);
 const bat=await readFile(join(root,'start-windows.bat'),'utf8');assert.ok(bat.startsWith('@echo off\r\n'));assert.ok(bat.includes('%~dp0start-windows.ps1'));assert.ok(bat.includes('-NoProfile'));
});

test('Mac 自动下载 Node 校验 SHA256，缓存可重用，错误校验阻止启动',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),bin=join(f.dir,'bin'),download=join(f.dir,'download'),runtime=join(f.dir,'runtime');await mkdir(bin);await mkdir(download);
 const dist='node-v22.99.0-darwin-'+(process.arch==='arm64'?'arm64':'x64');await mkdir(join(download,dist,'bin'),{recursive:true});
 const wrapper=`#!/bin/bash\nexec ${shellQuote(process.execPath)} "$@"\n`;
 await writeFile(join(download,dist,'bin','node'),wrapper,{mode:0o755});
 await execFile('tar',['-czf',join(download,dist+'.tar.gz'),'-C',download,dist]);
 const checksum=createHash('sha256').update(await readFile(join(download,dist+'.tar.gz'))).digest('hex');
 const manifest=join(download,'SHASUMS256.txt');await writeFile(manifest,`${checksum}  ${dist}.tar.gz\n`);
 await writeFile(join(bin,'node'),'#!/bin/bash\nexit 1\n',{mode:0o755});
 await writeFile(join(bin,'curl'),`#!/bin/bash\nurl=''\nout=''\nwhile [[ $# -gt 0 ]]; do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done\ncp ${shellQuote(download)}/"\${url##*/}" "$out"\n`,{mode:0o755});
 const env={PATH:bin+':'+process.env.PATH,GPT_UPGRADE_RUNTIME_DIR:runtime};
 let r=await run('mac',f,env);assert.equal(r.code,0,r.output);assert.equal(await exists(f.marker),true,r.output);assert.equal(await f.version(),'v1');
 await writeFile(join(bin,'curl'),'#!/bin/bash\nexit 99\n',{mode:0o755});r=await run('mac',f,env);assert.equal(r.code,0,r.output);
 await writeFile(join(bin,'curl'),`#!/bin/bash\nurl=''\nout=''\nwhile [[ $# -gt 0 ]]; do case "$1" in https:*) url="$1";; -o) shift; out="$1";; esac; shift; done\ncp ${shellQuote(download)}/"\${url##*/}" "$out"\n`,{mode:0o755});
 await writeFile(manifest,`${'0'.repeat(64)}  ${dist}.tar.gz\n`);
 r=await run('mac',f,{...env,GPT_UPGRADE_RUNTIME_DIR:runtime+'-bad'});assert.notEqual(r.code,0);assert.match(r.output,/校验失败/);assert.equal(await exists(join(runtime+'-bad','current')),false);
});

test('PowerShell: 缺少/过旧依赖时安装 Git 和 Node，安装失败立即停止',{skip:!psAvailable||process.platform==='win32'},async t=>{
 const f=await fixture(t),bin=join(f.dir,'bin');await mkdir(bin);
 const actualGit=(await execFile('which',['git'])).stdout.trim();
 for(const [name,binary,pkg]of [['node',process.execPath,'OpenJS.NodeJS.LTS'],['git',actualGit,'Git.Git']]){
  await writeFile(join(bin,name),`#!/bin/bash\n[[ -e ${shellQuote(join(bin,pkg))} ]] || exit 1\nexec ${shellQuote(binary)} "$@"\n`,{mode:0o755});
 }
 await writeFile(join(bin,'winget'),`#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == '--id' ]]; then shift; touch ${shellQuote(bin)}/"$1"; exit 0; fi; shift; done\nexit 1\n`,{mode:0o755});
 const env={PATH:bin+':'+process.env.PATH,ProgramFiles:bin};let r=await run('windows',f,env);assert.equal(r.code,0,r.output);assert.equal(await f.version(),'v1');
 assert.equal(await exists(join(bin,'Git.Git')),true);assert.equal(await exists(join(bin,'OpenJS.NodeJS.LTS')),true);
 await rm(join(bin,'OpenJS.NodeJS.LTS'));await writeFile(join(bin,'winget'),'#!/bin/bash\nexit 23\n',{mode:0o755});
 r=await run('windows',f,env);assert.notEqual(r.code,0);assert.match(r.output,/23/);
});

test('Mac 缺少 Git 时等待系统依赖安装完成再下载项目',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),bin=join(f.dir,'bin'),ready=join(f.dir,'git-installed');await mkdir(bin);
 const actualGit=(await execFile('which',['git'])).stdout.trim();
 await writeFile(join(bin,'git'),`#!/bin/bash\n[[ -e ${shellQuote(ready)} ]] || exit 1\nexec ${shellQuote(actualGit)} "$@"\n`,{mode:0o755});
 await writeFile(join(bin,'xcode-select'),`#!/bin/bash\nif [[ "$1" == '--install' ]]; then touch ${shellQuote(ready)}; exit 0; fi\n[[ -e ${shellQuote(ready)} ]]\n`,{mode:0o755});
 const r=await run('mac',f,{PATH:bin+':'+process.env.PATH});assert.equal(r.code,0,r.output);assert.equal(await exists(ready),true);assert.equal(await f.version(),'v1');
});
