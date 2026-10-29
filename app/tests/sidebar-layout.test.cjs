const test = require('node:test'), assert = require('node:assert/strict');
const { geometry, resize, separatorValues } = require('../renderer/sidebar-layout.js');
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.1, `${a} differs from ${b}`);
test('three panes consume available height while preserving each header and minimum content', () => {
 const input=[5000,3000,2000], g=geometry(600,[30,32,34],[false,false,false],input);
 close(g.sizes.reduce((a,b)=>a+b,0)+16,600); assert.deepEqual(g.pairs,[[0,1],[1,2]]);
 assert.ok(g.bodies.every(n=>n>=32)); assert.deepEqual(input,[5000,3000,2000]);
 const result=resize(input,g,0,40), moved=geometry(600,[30,32,34],[false,false,false],result);
 close(moved.bodies[0]-g.bodies[0],40);close(moved.bodies[1]-g.bodies[1],-40);close(moved.bodies[2],g.bodies[2]);
 assert.equal(result.reduce((a,b)=>a+b,0),10000);
});
test('fold/unfold keeps hidden preferences and only creates useful separator pairs',()=>{
 const input=[5000,3000,2000], full=geometry(600,[30,30,30],[false,false,false],input);
 const folded=geometry(600,[30,30,30],[false,true,false],input);assert.deepEqual(folded.pairs,[[0,2],null]);assert.equal(folded.sizes[1],30);
 const moved=resize(input,folded,0,20);assert.equal(moved[1],3000);
 assert.deepEqual(geometry(600,[30,30,30],[false,false,false],input),full);
 assert.deepEqual(geometry(600,[30,30,30],[true,false,true],input).pairs,[null,null]);
 assert.deepEqual(geometry(600,[30,30,30],[true,true,true],input).sizes,[30,30,30]);
});
test('small geometry and extreme drags retain finite nonnegative bodies and header heights',()=>{
 for(const height of [0,50,120,200,300,900])for(const folded of [[false,false,false],[false,true,false],[true,true,true]]){
  const g=geometry(height,[30,30,30],folded,[5000,3000,2000]);assert.ok(g.sizes.every(n=>Number.isFinite(n)&&n>=30));
  for(const delta of [-100000,100000]){const w=resize([5000,3000,2000],g,0,delta);assert.equal(w.reduce((a,b)=>a+b,0),10000);assert.ok(w.every(n=>Number.isInteger(n)&&n>0));}
 }
});
test('invalid or missing retained sizing falls back without a metadata write',()=>{
 const d=geometry(500,[30,30,30],[false,false,false]);
 for(const input of [null,[0,5000,5000],[NaN,1,9999],['5000',3000,2000],new Array(3)])assert.deepEqual(geometry(500,[30,30,30],[false,false,false],input),d);
});

test('keyboard Home and End reach bounds without losing the other section preference',()=>{
 const input=[5000,3000,2000], g=geometry(600,[30,30,30],[false,false,false],input);
 const low=resize(input,g,0,-Infinity), high=resize(input,g,0,Infinity);
 assert.equal(low[0],1);assert.equal(high[1],1);assert.equal(low[2],2000);assert.equal(high[2],2000);
});

test('published separator ranges include the actual position at both bounds',()=>{
 for(const height of [204,340,600,800])for(const preference of [[1,4999,5000],[9998,1,1],[5000,3000,2000]]){
  const layout=geometry(height,[30,30,30],[false,false,false],preference);
  for(const index of [0,1]){
   const value=separatorValues(layout,index);assert.ok(value.min<=value.now&&value.now<=value.max,JSON.stringify({height,preference,index,value}));
   assert.ok(value.min>=0&&value.max<=100);
  }
 }
 assert.equal(separatorValues(geometry(600,[30,30,30],[true,true,true]),0),null);
 assert.equal(separatorValues(geometry(0,[30,30,30],[false,false,false]),0),null);
});
