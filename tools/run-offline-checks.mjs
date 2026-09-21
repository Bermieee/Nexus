import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=process.argv[2]?path.resolve(process.argv[2]):fs.mkdtempSync(path.join(os.tmpdir(),'nexus-offline-checks-'));
fs.mkdirSync(output,{recursive:true});
const standalone=[];
for(const name of fs.readdirSync(path.join(root,'tests')).filter(n=>n.endsWith('.mjs')).sort()){
    const start=performance.now();
    const run=spawnSync(process.execPath,[`tests/${name}`],{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024});
    fs.writeFileSync(path.join(output,name+'.log'),`${run.stdout||''}${run.stderr||''}${run.error||''}`);
    standalone.push({name,pass:run.status===0,exitCode:run.status,ms:Math.round(performance.now()-start)});
    console.log(`${run.status===0?'PASS':'FAIL'} ${name}`);
}
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(e.name==='node_modules'?[]:files(path.join(dir,e.name))):[path.join(dir,e.name)]);}
const syntax=[];
for(const file of files(root).filter(p=>/\.(?:js|mjs)$/.test(p))){
    const run=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:20000});
    syntax.push({file:path.relative(root,file).split(path.sep).join('/'),pass:run.status===0});
    if(run.status!==0)console.error(`SYNTAX FAIL ${file}: ${run.stderr}`);
}
const report={node:process.version,date:new Date().toISOString(),standalone,syntax,liveAcceptance:'NOT RUN'};
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(`Standalone ${standalone.filter(x=>x.pass).length}/${standalone.length}; syntax ${syntax.filter(x=>x.pass).length}/${syntax.length}. Evidence: ${output}`);
process.exitCode=standalone.some(x=>!x.pass)||syntax.some(x=>!x.pass)?1:0;
