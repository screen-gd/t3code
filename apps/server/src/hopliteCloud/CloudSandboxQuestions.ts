/** Runs inside a sandbox as a stdio MCP server; question files outlive client connections. */
export const questionServerSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const dir = path.join(process.env.HOME, '.t3-task', 'questions');
fs.mkdirSync(dir, {recursive:true});
const options = {type:'array',items:{type:'object',required:['label'],properties:{label:{type:'string'},description:{type:'string'}}}};
const tool = {name:'request_user_input',description:'Ask the main agent a structured question. It answers from context or asks the user with its interactive picker. Wait for the answer; never print a question and finish instead.',inputSchema:{type:'object',required:['questions'],properties:{questions:{type:'array',minItems:1,items:{type:'object',required:['question','options'],properties:{question:{type:'string'},options}}}}}};
const reply = (id,result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const writeOnce = (file,value) => {
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(tmp,value);
  try { fs.linkSync(tmp,file); } catch(e) { if(e.code!=='EEXIST') throw e; } finally { fs.unlinkSync(tmp); }
};
async function handle(message) {
  if (message.id === undefined) return;
  if (message.method === 'initialize') return reply(message.id,{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'t3-delegate-questions',version:'1'}});
  if (message.method === 'tools/list') return reply(message.id,{tools:[tool]});
  if (message.method !== 'tools/call' || message.params.name !== tool.name) return reply(message.id,{});
  const parts = message.params.arguments.questions;
  if (!Array.isArray(parts) || !parts.length || parts.some(p => typeof p.question !== 'string' || !Array.isArray(p.options) || p.options.some(o => typeof o.label !== 'string'))) throw new Error('Expected questions with question text and labeled options');
  const turn = fs.readFileSync(path.join(dir,'..','turn'),'utf8').trim();
  const questionId = 'q_' + crypto.createHash('sha256').update(turn+JSON.stringify(parts)).digest('hex').slice(0,32);
  const file = path.join(dir,questionId);
  const pending = {questionId,runId:'turn-'+turn,parts:parts.map(p=>({question:p.question,options:p.options.map(o=>({label:o.label,description:o.description||''}))}))};
  writeOnce(file+'.json',JSON.stringify(pending));
  const answer = await new Promise((resolve,reject) => {
    const check = () => { try { const value=JSON.parse(fs.readFileSync(file+'.answer','utf8')); watcher.close(); resolve(value); } catch(e) { if(e.code!=='ENOENT') {watcher.close();reject(e);} } };
    const watcher = fs.watch(dir,check);
    check();
  });
  reply(message.id,{content:[{type:'text',text:JSON.stringify({questionId,...answer})}]});
}
const requests = new Set();
readline.createInterface({input:process.stdin}).on('line',line=>{
  let message;
  try { message=JSON.parse(line); } catch { return; }
  if(message.id !== undefined) {
    if(requests.has(message.id)) return;
    requests.add(message.id);
  }
  handle(message).catch(error=>reply(message.id,{isError:true,content:[{type:'text',text:error.message}]}));
});
`;

export const readQuestionsScript = () => `node -e '
const fs=require("node:fs"),path=require("node:path");
const dir=path.join(process.env.HOME,".t3-task","questions");
const questions=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith(".json")&&!fs.existsSync(path.join(dir,n.slice(0,-5)+".answer"))).map(n=>JSON.parse(fs.readFileSync(path.join(dir,n),"utf8"))):[];
console.log(JSON.stringify(questions));
'`;

/** Exclusive creation makes a retried answer immutable and wakes only its question. */
export const answerQuestionScript = () => `node -e '
const fs=require("node:fs"),path=require("node:path");
const file=path.join(process.env.HOME,".t3-task","questions",process.env.T3_QUESTION_ID);
if(!fs.existsSync(file+".json")) process.exit(2);
const answer=JSON.stringify(process.env.T3_QUESTION_DISMISS==="true"?{dismissed:true}:{answer:process.env.T3_QUESTION_ANSWER});
const tmp=file+"."+require("node:crypto").randomUUID()+".tmp";
fs.writeFileSync(tmp,answer);
try { fs.linkSync(tmp,file+".answer"); } catch(e) { if(e.code!=="EEXIST") throw e; if(fs.readFileSync(file+".answer","utf8")!==answer) process.exitCode=3; } finally {fs.unlinkSync(tmp);}
'`;
