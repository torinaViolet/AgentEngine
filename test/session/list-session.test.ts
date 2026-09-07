import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {ListSession,Session} from '../../src/session';
import {Message} from '../../src/message';
import {Agent} from '../../src/agent';

describe('ListSession',()=>{
 it('selects alternatives without erasing later rows and rejects stale generation',()=>{
  const session=ListSession.create('system');session.addUser('hello');session.addAssistant(Message.assistant('A'));
  const row=session.rows[1], original=row.selectedCandidateId;
  session.addUser('later');session.addAssistant(Message.assistant('later answer'));
  const alternative=session.addCandidate(row.id,Message.assistant('B'));
  assert.deepEqual(session.history(false).map(m=>m.text),['hello','B','later','later answer']);
  assert.equal(session.staleRowIds.length,2);assert.throws(()=>session.beginGeneration(),/History changed/);
  session.select(row.id,original);assert.equal(session.staleRowIds.length,0);
  session.select(row.id,alternative.id);session.acceptHistory();assert.equal(session.staleRowIds.length,0);
 });
 it('keeps one tool trace per candidate and hides the old trace during regeneration',()=>{
  const session=ListSession.create();session.addUser('question');session.beginGeneration();
  session.addAssistant(Message.assistantToolCalls([{id:'c1',name:'lookup',arguments:'{}'}]));
  session.addTool([Message.tool('c1','old result')]);session.addAssistant(Message.assistant('old answer'));session.endGeneration();
  const row=session.rows[1],old=row.selectedCandidateId;
  session.regenerate(row.id);assert.equal(session.history(false).length,1);
  session.beginGeneration();session.addAssistant(Message.assistant('new answer'));session.endGeneration();
  assert.equal(row.candidates.length,2);assert.equal(session.history(false).length,2);
  session.select(row.id,old);assert.equal(session.history(false).length,4);
 });
 it('round trips IDs, metadata, media and detached messages',()=>{
  const tree=Session.create();const message=tree.addUser('original');message.addImage('https://example.test/image.png');
  const session=ListSession.create();session.addMessage(message);session.addAssistant(Message.assistant('reply'));
  const json=session.toJSON();const restored=ListSession.fromJSON(json);
  assert.deepEqual(restored.toJSON(),json);assert.equal(restored.staleRowIds.length,0);
  restored.history(false)[0].setText('changed');assert.equal(message.text,'original');
  const invalid=JSON.parse(JSON.stringify(json));invalid.rows[0].selectedCandidateId='missing';
  assert.throws(()=>ListSession.fromJSON(invalid));
 });
 it('cleans generation locks after a failed empty generation',()=>{
  const s=ListSession.create();s.addUser('x');s.beginGeneration();assert.throws(()=>s.clear());s.endGeneration();
  assert.equal(s.rows.length,1);s.clear();assert.equal(s.rows.length,0);
 });
 it('works with Agent and preserves inferred tree-specific types',async()=>{
  const client={chat:{completions:{create:async()=>({choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}]})}}};
  const treeAgent=new Agent({client,model:'fake',session:Session.create()});assert.ok(treeAgent.session.root);
  const session=ListSession.create();const agent=new Agent({client,model:'fake',session});
  await agent.run('hello',{stream:false});assert.equal(agent.session.rows.length,2);
  session.regenerate(session.rows[1].id);await agent.generate({stream:false});
  assert.equal(session.rows[1].candidates.length,2);assert.equal(session.history(false).length,2);
 });
});

it('keeps serialized context fingerprints bounded for long histories',()=>{
 const s=ListSession.create();for(let i=0;i<100;i++)s.addUser('large message '+i+'x'.repeat(1000));
 assert.ok(JSON.stringify(s.toJSON()).length<160000);
 assert.equal(s.staleRowIds.length,0);s.history(false)[0].setText('edited');assert.equal(s.staleRowIds.length,99);
});

it('does not leave a pending regeneration after stale-prefix rejection',()=>{
 const s=ListSession.create();s.addUser('first');s.addAssistant(Message.assistant('answer'));s.addUser('later');s.addAssistant(Message.assistant('later answer'));
 s.addCandidate(s.rows[1].id,Message.assistant('alternative'));s.regenerate(s.rows[3].id);assert.throws(()=>s.beginGeneration(),/History changed/);
 s.acceptHistory();s.addUser('now accepted');assert.equal(s.rows.length,5);
});
