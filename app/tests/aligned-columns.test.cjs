const test=require('node:test'),assert=require('node:assert/strict');
const {alignedColumnWidths,columnWindow,columnSnap}=require('../renderer/collaboration-overview.js');
for(const count of [4,7,8])test(`${count} members use available width, fit when possible, and preserve the minimum on resize`,()=>{
  for(const width of [240,780,1048,1224,1368,1544,2100]){
    const m=alignedColumnWidths(count,width,[4,1,2,1]);
    assert.equal(m.capacity,Math.max(1,Math.floor(width/260)));
    assert.equal(m.widths.length,count);assert.ok(m.widths.every(w=>w>=Math.min(260,width)-1e-8));
    const total=m.widths.reduce((a,b)=>a+b,0);assert.ok(Math.abs(total-m.total)<1e-7);
    if(count<=m.capacity)assert.ok(Math.abs(total-width)<1e-7,'All members fit without horizontal scroll');
    else assert.ok(total>width);
  }
});
test('paging counts partial/offscreen members and reaches both ends without hiding members behind expansion',()=>{
  const widths=Array(8).fill(300);let left=0,steps=0;
  assert.deepEqual(columnWindow(widths,left,900),{before:0,after:5,previous:0,next:900});
  while(columnWindow(widths,left,900).after){const m=columnWindow(widths,left,900);left=Math.min(1500,m.next);assert.ok(++steps<4);}
  assert.equal(left,1500);assert.equal(columnWindow(widths,left,900).before,5);
  while(columnWindow(widths,left,900).before)left=columnWindow(widths,left,900).previous;
  assert.equal(left,0);assert.equal(columnWindow(widths,50,900).before,1);assert.equal(columnWindow(widths,50,900).after,5);
});
test('empty and all-fit strips have no paging action; invalid saved weights do not break layout',()=>{
  assert.deepEqual(alignedColumnWidths(0,1000).widths,[]);
  const m=alignedColumnWidths(4,1280,[NaN,-1,Infinity,0]);assert.deepEqual(m.widths,[320,320,320,320]);
  assert.deepEqual(columnWindow(m.widths,0,1280),{before:0,after:0,previous:0,next:0});
  assert.deepEqual(columnWindow([],0,1280),{before:0,after:0,previous:0,next:0});
});

test('continuing makes progress even when a resized column is wider than the viewport',()=>{
  const widths=[1000,300,300],width=900,total=1600;let left=0,steps=0;
  while(columnWindow(widths,left,width).after){const next=Math.min(total-width,columnWindow(widths,left,width).next);assert.ok(next>left,'Each continue advances');left=next;assert.ok(++steps<4);}
  assert.equal(left,700);
});


test('settling a horizontal gesture aligns to a column rather than a half column',()=>{
  const widths=Array(8).fill(300);
  assert.equal(columnSnap(widths,380,900,0),300);
  assert.equal(columnSnap(widths,760,900,300),900);
  assert.equal(columnSnap(widths,1520,900,1200),1500,'The last group clamps to the reachable end');
});
test('small gestures escape their original snap in either direction, but no movement stays put',()=>{
  const widths=Array(8).fill(300);
  for(const step of [1,8,20]){
    assert.equal(columnSnap(widths,step,900,0),300);
    assert.equal(columnSnap(widths,1500-step,900,1500),1200);
  }
  assert.equal(columnSnap(widths,168,900,160),300,'A gesture from a restored half-column does not go backward');
  assert.equal(columnSnap(widths,160,900,160),160,'An untouched restored half-column stays put during nested scrolling');
  assert.equal(columnSnap(widths,300,900,300),300,'Nested scrolling must not manufacture an outer action');
});
test('settling respects unequal resized widths, a single oversized column, and all-fit strips',()=>{
  assert.equal(columnSnap([400,260,340,300],8,900,0),400);
  assert.equal(columnSnap([1500,300],850,900,0),900,'Oversized contents remain reachable');
  assert.equal(columnSnap([300,300],8,900,0),0);
  assert.equal(columnSnap([],8,900,0),0);
});


test('unequal overflow columns retain their ratios within whole viewport pages',()=>{
  for(const width of [794,1224,1544]){
    const m=alignedColumnWidths(8,width,[1.2,.8,1,1,1,1,1,1]);
    for(let start=0;start<8;start+=m.capacity){
      assert.ok(Math.abs(m.widths.slice(start,start+m.capacity).reduce((a,b)=>a+b,0)-width)<1e-7);
    }
    const target=columnSnap(m.widths,380,width,0);
    assert.ok(target>0);assert.ok(Math.abs(target/width-Math.round(target/width))<1e-7,'Only whole pages are selected for unequal widths');
  }
});
