const ccxt = require('ccxt');
(async () => {
  const ex = new ccxt.binance();
  const o = await ex.fetchOHLCV('BTC/USDT', '15m', undefined, 100);
  const v = o.map(d => d[5]), c = o.map(d => d[4]);
  const h = o.map(d => d[2]), l = o.map(d => d[3]);
  const vSma = v.slice(-20).reduce((a,b) => a+b, 0) / 20;
  let pP=0,pM=0,pA=0,adx=0;
  for(let i=1;i<c.length;i++){
    const up=h[i]-h[i-1],dn=l[i-1]-l[i];
    const dmP=(up>dn&&up>0)?up:0,dmM=(dn>up&&dn>0)?dn:0;
    const tr=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    pA=i<14?pA+tr:pA-pA/14+tr;
    pP=i<14?pP+dmP:pP-pP/14+dmP;
    pM=i<14?pM+dmM:pM-pM/14+dmM;
    if(i>=14){const diP=(pP/pA)*100,diM=(pM/pA)*100;adx=Math.abs(diP-diM)/(diP+diM)*100;}
  }
  let g=0,ls=0;
  for(let i=1;i<=14;i++){const d=c[c.length-1-i+1]-c[c.length-1-i];d>0?g+=d:ls-=d;}
  const rsi=100-(100/(1+g/14/(ls/14)));
  console.log('Price :', c[c.length-1]);
  console.log('ADX   :', adx.toFixed(2), adx>32?'OK':'Low');
  console.log('RSI   :', rsi.toFixed(2), (rsi>28&&rsi<42)?'SELL range':'not ready');
  console.log('Vol   :', v[v.length-1].toFixed(2), 'Need:', (vSma*1.2).toFixed(2), v[v.length-1]>vSma*1.2?'HIGH':'Low');
})();
