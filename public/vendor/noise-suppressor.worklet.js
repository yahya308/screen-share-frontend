var ct=Float32Array.BYTES_PER_ELEMENT;var z=(async function(F={}){var s,r=F,f=typeof window=="object",o=typeof WorkerGlobalScope<"u";typeof process=="object"&&process.versions?.node&&process.type;var l=import.meta.url,h="";function $(t){return h+t}var T,A;if(f||o){try{h=new URL(".",l).href}catch{}o&&(A=t=>{var e=new XMLHttpRequest;return e.open("GET",t,!1),e.responseType="arraybuffer",e.send(null),new Uint8Array(e.response)}),T=async t=>{var e=await fetch(t,{credentials:"same-origin"});if(e.ok)return e.arrayBuffer();throw new Error(e.status+" : "+e.url)}}console.log.bind(console);var w=console.error.bind(console),m,N=!1,B,U,v,E,C=!1;function k(){var t=v.buffer;new Int8Array(t),new Int16Array(t),E=new Uint8Array(t),new Uint16Array(t),new Int32Array(t),new Uint32Array(t),r.HEAPF32=new Float32Array(t),new Float64Array(t),new BigInt64Array(t),new BigUint64Array(t)}function O(){C=!0,p.d()}var d=0,y=null;function j(t){d++}function K(t){if(d--,d==0&&y){var e=y;y=null,e()}}function W(t){t="Aborted("+t+")",w(t),N=!0,t+=". Build with -sASSERTIONS for more info.";var e=new WebAssembly.RuntimeError(t);throw U?.(e),e}var R;function Q(){return r.locateFile?$("gtcrn.wasm"):new URL("gtcrn.wasm",import.meta.url).href}function V(t){if(t==R&&m)return new Uint8Array(m);if(A)return A(t);throw"both async and sync fetching of the wasm failed"}async function Y(t){if(!m)try{var e=await T(t);return new Uint8Array(e)}catch{}return V(t)}async function Z(t,e){try{var n=await Y(t);return await WebAssembly.instantiate(n,e)}catch(i){w(`failed to asynchronously prepare wasm: ${i}`),W(i)}}async function x(t,e,n){if(!t&&typeof WebAssembly.instantiateStreaming=="function")try{var i=fetch(e,{credentials:"same-origin"});return await WebAssembly.instantiateStreaming(i,n)}catch(a){w(`wasm streaming compile failed: ${a}`),w("falling back to ArrayBuffer instantiation")}return Z(e,n)}function X(){return{a:at}}async function J(){function t(i,a){return p=i.exports,v=p.c,k(),nt(p),K("wasm-instantiate"),p}j("wasm-instantiate");function e(i){return t(i.instance)}var n=X();return R??(R=Q()),e(await x(m,R,n))}var L=typeof TextDecoder<"u"?new TextDecoder:void 0,q=(t,e=0,n=NaN)=>{for(var i=e+n,a=e;t[a]&&!(a>=i);)++a;if(a-e>16&&t.buffer&&L)return L.decode(t.subarray(e,a));for(var _="";e<a;){var c=t[e++];if(!(c&128)){_+=String.fromCharCode(c);continue}var I=t[e++]&63;if((c&224)==192){_+=String.fromCharCode((c&31)<<6|I);continue}var D=t[e++]&63;if((c&240)==224?c=(c&15)<<12|I<<6|D:c=(c&7)<<18|I<<12|D<<6|t[e++]&63,c<65536)_+=String.fromCharCode(c);else{var H=c-65536;_+=String.fromCharCode(55296|H>>10,56320|H&1023)}}return _},S=(t,e)=>t?q(E,t,e):"",tt=(t,e,n,i)=>W(`Assertion failed: ${S(t)}, at: `+[e?S(e):"unknown filename",n,i?S(i):"unknown function"]),et=()=>2147483648,rt=(t,e)=>Math.ceil(t/e)*e,st=t=>{var e=(t-v.buffer.byteLength+65535)/65536|0;try{return v.grow(e),k(),1}catch{}},it=t=>{var e=E.length;t>>>=0;var n=et();if(t>n)return!1;for(var i=1;i<=4;i*=2){var a=e*(1+.2/i);if(a=Math.min(a,t+100663296),st(Math.min(n,rt(Math.max(t,a),65536))))return!0}return!1};r.wasmBinary&&(m=r.wasmBinary);function nt(t){r._gtcrn_create=t.e,r._free=t.f,r._gtcrn_destroy=t.g,r._gtcrn_model_run=t.h,r._gtcrn_process=t.i,r._gtcrn_process_48k=t.j,r._malloc=t.k}var at={a:tt,b:it},p=await J();function M(){if(d>0){y=M;return}if(d>0){y=M;return}function t(){r.calledRun=!0,!N&&(O(),B?.(r))}t()}return M(),C?s=r:s=new Promise((t,e)=>{B=t,U=e}),s});var P=128,u=768,G=u/P,g=Float32Array.BYTES_PER_ELEMENT,ot=3,b=class extends AudioWorkletProcessor{constructor(s){super(),this.frameIn=new Float32Array(u),this.frameOut=new Float32Array(u),this.slot=0,this.ready=!1,this.failed=!1,this.closed=!1,this.silentSamples=0,this.silenceChecked=!1,this.port.onmessage=r=>{r.data==="close"&&this.close()},z({wasmBinary:s.processorOptions.wasmBinary,locateFile:r=>r}).then(r=>{this.closed||(this.module=r,this.openState(),this.ready=!0,this.port.postMessage({type:"ready"}))}).catch(r=>this.fail(r))}openState(){let s=this.module;if(this.state=s._gtcrn_create(),this.inPtr=s._malloc(u*g),this.outPtr=s._malloc(u*g),!this.state||!this.inPtr||!this.outPtr)throw new Error("GTCRN belle\u011Fi ayr\u0131lamad\u0131")}freeState(){let s=this.module;s&&(this.inPtr&&s._free(this.inPtr),this.outPtr&&s._free(this.outPtr),this.state&&s._gtcrn_destroy(this.state),this.inPtr=this.outPtr=this.state=0)}fail(s){this.failed||(this.failed=!0,this.port.postMessage({type:"error",message:String(s?.message||s)}))}close(){this.closed=!0;try{this.freeState()}catch{}}runModel(){let s=this.module,r=this.inPtr/g,f=this.outPtr/g;s.HEAPF32.set(this.frameIn,r),s._gtcrn_process_48k(this.state,this.inPtr,this.outPtr);let o=s.HEAPF32.subarray(f,f+u),l=0;for(let h=0;h<u;h++)l+=o[h]*o[h];Number.isFinite(l)?this.frameOut.set(o):(this.frameOut.set(this.frameIn),this.freeState(),this.openState())}watchForDeadInput(s){if(!this.silenceChecked){for(let r=0;r<s.length;r++)if(s[r]!==0){this.silenceChecked=!0;return}this.silentSamples+=s.length,this.silentSamples>=sampleRate*ot&&(this.silenceChecked=!0,this.port.postMessage({type:"silent-input"}))}}process(s,r){if(this.closed)return!1;let f=r[0][0],o=s[0]?.[0];if(!o)return f.fill(0),!0;if(this.watchForDeadInput(o),!this.ready||this.failed)return f.set(o),!0;try{this.frameIn.set(o,this.slot*P),this.slot===G-1&&this.runModel();let l=(this.slot+1)%G;f.set(this.frameOut.subarray(l*P,(l+1)*P)),this.slot=l}catch(l){this.fail(l),f.set(o)}return!0}};registerProcessor("velo-noise-suppressor",b);
/*! Bundled license information:

@sapphi-red/gtcrn-wasm/dist/index.js:
  (*!
   * GTCRN
   *
   * MIT License
   * 
   * Copyright (c) 2024 Rong Xiaobin
   * 
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   * 
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   * 
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   *)
  (*!
   * pffft
   *
   * Copyright (c) 2020  Dario Mambro ( dario.mambro@gmail.com )
   * Copyright (c) 2019  Hayati Ayguen ( h_ayguen@web.de )
   * Copyright (c) 2013  Julien Pommier ( pommier@modartt.com )
   * 
   * Copyright (c) 2004 the University Corporation for Atmospheric
   * Research ("UCAR"). All rights reserved. Developed by NCAR's
   * Computational and Information Systems Laboratory, UCAR,
   * www.cisl.ucar.edu.
   * 
   * Redistribution and use of the Software in source and binary forms,
   * with or without modification, is permitted provided that the
   * following conditions are met:
   * 
   * - Neither the names of NCAR's Computational and Information Systems
   * Laboratory, the University Corporation for Atmospheric Research,
   * nor the names of its sponsors or contributors may be used to
   * endorse or promote products derived from this Software without
   * specific prior written permission.  
   * 
   * - Redistributions of source code must retain the above copyright
   * notices, this list of conditions, and the disclaimer below.
   * 
   * - Redistributions in binary form must reproduce the above copyright
   * notice, this list of conditions, and the disclaimer below in the
   * documentation and/or other materials provided with the
   * distribution.
   * 
   * THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
   * EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO THE WARRANTIES OF
   * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
   * NONINFRINGEMENT. IN NO EVENT SHALL THE CONTRIBUTORS OR COPYRIGHT
   * HOLDERS BE LIABLE FOR ANY CLAIM, INDIRECT, INCIDENTAL, SPECIAL,
   * EXEMPLARY, OR CONSEQUENTIAL DAMAGES OR OTHER LIABILITY, WHETHER IN AN
   * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
   * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS WITH THE
   * SOFTWARE.
   *)
*/
