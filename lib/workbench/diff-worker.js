// Patience-style line anchors plus common edges inside a changed line.
// Bounded recursion and output keep long setting cards away from quadratic LCS.
export function diffText(before,after){
    const output=[];
    const add=(type,text)=>{if(!text)return;const last=output.at(-1);if(last?.type===type)last.text+=text;else output.push({type,text});};
    function edges(a,b){
        let p=0,s=0;
        while(p<a.length&&p<b.length&&a[p]===b[p])p++;
        while(s<a.length-p&&s<b.length-p&&a[a.length-1-s]===b[b.length-1-s])s++;
        if(p&&a.charCodeAt(p-1)>=0xD800&&a.charCodeAt(p-1)<=0xDBFF)p--;
        if(s&&a.charCodeAt(a.length-s)>=0xDC00&&a.charCodeAt(a.length-s)<=0xDFFF)s--;
        add('same',a.slice(0,p));add('remove',a.slice(p,a.length-s));add('add',b.slice(p,b.length-s));if(s)add('same',a.slice(a.length-s));
    }
    function walk(a,b,depth=0){
        let p=0,s=0;while(p<a.length&&p<b.length&&a[p]===b[p])p++;
        while(s<a.length-p&&s<b.length-p&&a[a.length-1-s]===b[b.length-1-s])s++;
        add('same',a.slice(0,p).join(''));
        const x=a.slice(p,a.length-s),y=b.slice(p,b.length-s);
        if(!x.length)add('add',y.join(''));
        else if(!y.length)add('remove',x.join(''));
        else if(depth>8||x.length*y.length<2||output.length>1500)edges(x.join(''),y.join(''));
        else{
            const positions=new Map(),counts=new Map();
            x.forEach((t,i)=>positions.set(t,positions.has(t)?-1:i));
            y.forEach(t=>counts.set(t,(counts.get(t)||0)+1));
            const pairs=[];y.forEach((t,j)=>{const i=positions.get(t);if(i>=0&&counts.get(t)===1)pairs.push({i,j,prev:-1});});
            const tails=[];
            pairs.forEach((v,k)=>{let l=0,r=tails.length;while(l<r){const m=(l+r)>>1;if(pairs[tails[m]].i<v.i)l=m+1;else r=m;}v.prev=l?tails[l-1]:-1;tails[l]=k;});
            const anchors=[];let k=tails.at(-1);while(k!=null&&k>=0){anchors.push(pairs[k]);k=pairs[k].prev;}anchors.reverse();
            if(!anchors.length)edges(x.join(''),y.join(''));
            else{let i=0,j=0;for(const v of anchors){walk(x.slice(i,v.i),y.slice(j,v.j),depth+1);add('same',x[v.i]);i=v.i+1;j=v.j+1;}walk(x.slice(i),y.slice(j),depth+1);}
        }
        if(s)add('same',a.slice(a.length-s).join(''));
    }
    if(before===after)return [{type:'same',text:before}];
    if(before.length+after.length>1000000)return [{type:'remove',text:before},{type:'add',text:after}];
    walk(before.match(/[^\n]*\n|[^\n]+$/g)||[],after.match(/[^\n]*\n|[^\n]+$/g)||[]);
    return output;
}
if(typeof self!=='undefined'&&typeof document==='undefined')self.onmessage=event=>{
    const {id,before,after}=event.data;
    self.postMessage({id,segments:diffText(before,after)});
};
