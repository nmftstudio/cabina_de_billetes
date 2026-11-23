const Sim=require('./public/sim.js');
function bot(seed,total,speed=450,jit=20,rt=.25){const S=Sim.newGame(seed,total);let p={x:180,y:260},tg=null,rc=0;
for(let f=0;f<Sim.FRAMES;f++){rc-=Sim.DT;if(rc<=0){rc=rt;let bd=1e9;tg=null;for(const b of S.bills)if(b.on){const d=Math.hypot(b.x-p.x,b.y-p.y);if(d<bd){bd=d;tg=b}}}
let tap=false;if(tg&&tg.on){const dx=tg.x+tg.vx*Sim.P.close-p.x+(Math.random()-.5)*jit,dy=tg.y+tg.vy*Sim.P.close-p.y+(Math.random()-.5)*jit,d=Math.hypot(dx,dy)||1,m=Math.min(d,speed*Sim.DT);p.x+=dx/d*m;p.y+=dy/d*m;if(d<Sim.P.grab*.6&&S.cd<=0&&!S.gr)tap=true}
Sim.tick(S,Sim.pack(p.x,p.y),tap)}return S.got}
const r=[];for(let i=0;i<80;i++)r.push(bot(1000+i*7919,500));r.sort((a,b)=>a-b);
console.log('Bot (80 partidas): mediana',r[40],'p90',r[72],'max',r[79],'llegan a la mitad:',r.filter(x=>x>=250).length/80*100+'%');
