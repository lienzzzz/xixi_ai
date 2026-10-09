/* Xixi Demo UI prototype. `?mode=mock` = local interaction; `?mode=live` = current serve-chat API.
 * This is UI code, not a replacement for Xixi ResidentRuntime. No automatic sensor upload. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const live = new URLSearchParams(location.search).get('mode') === 'live';
  const state = { on:false, camera:false, proactive:false, speak:true, busy:false, recording:false,
    recorder:null, cameraTimer:null, cameraInFlight:false, cursor:0, turnCount:0, session:null,
    audioQueue:[], playing:false, audioNode:null, audioEnd:null, lastEvent:'尚未发生操作', lastCameraState:null };
  const time = () => new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
  const escapeError = (error) => error instanceof Error ? error.message : String(error);
  function logEvent(text) {
    state.lastEvent = text; $('info-event').textContent=text;
    const el=$('event-log'); el.textContent = `[${time()}] ${text}\n` + el.textContent.slice(0,7500);
  }
  function toast(text, error=false) {
    const box=document.createElement('div'); box.className='toast'+(error?' error':''); box.textContent=text;
    $('toast-container').append(box); setTimeout(()=>box.remove(),4400);
  }
  async function request(path, {method='GET', body, signal}={}) {
    const res=await fetch(path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal,cache:'no-store'});
    if (!res.ok) { let message=`请求失败 ${res.status}`; try { const detail=await res.json();message=detail.error||detail.message||message; }catch{} throw new Error(message); }
    return res.json();
  }
  function status(message,{busy=false}={}) { $('composer-status').textContent=message; $('composer-dot').classList.toggle('busy',busy); }
  function updateUI() {
    $('companion-state').textContent = state.recording ? '在听你说话' : state.busy ? '正在想怎么回答' : state.on ? '陪伴已开启' : '安静待机';
    $('companion-message').textContent=state.recording?'点击麦克风结束录音，西西会接着回答。':state.busy?'正在处理这一轮，可以看到文字和语音。':state.on?'有合适话题时会主动开口；语音暂时仍需按键发起。':'准备好了就打开陪伴，也可以直接打字聊天。';
    $('companion-toggle').classList.toggle('running',state.on);
    $('power-label').textContent=state.on?'暂停陪伴':'开启陪伴'; $('power-symbol').textContent=state.on?'Ⅱ':'▶';
    $('orb').classList.toggle('active',state.on); $('orb').classList.toggle('speaking',state.busy);
    $('rail-led').classList.toggle('on',state.on); $('rail-caption').textContent=state.on?'主动陪伴已开启':'尚未开启主动陪伴';
    $('chip-proactive').textContent='主动聊天：'+(state.proactive?'开启':'关闭');
    $('chip-vision').textContent='摄像头：'+(state.camera?'预览中':'关闭');
    $('chip-mic').textContent=state.recording?'麦克风：录音中':'麦克风：按键说话';
    $('proactive-switch').checked=state.proactive; $('tts-switch').checked=state.speak;
    $('camera-toggle').textContent=state.camera?'关闭摄像头':'开启摄像头';
    $('camera-led').classList.toggle('on',state.camera); $('camera-overlay').textContent=state.camera?'● 本地预览中':'● 画面未连接';
    $('info-mode').textContent=live?'真实接口模式':'模拟演示'; $('info-turns').textContent=String(state.turnCount);
    $('info-proactive').textContent=state.proactive?'开启':'关闭'; $('info-camera').textContent=state.camera?'本地预览中':'关闭';
    $('info-mic').textContent=state.recording?'录音中':'按键式待机'; $('info-tts').textContent=state.speak?'开启':'关闭';
    $('mic-button').classList.toggle('recording',state.recording); $('mic-button').setAttribute('aria-label',state.recording?'结束语音录制并发送':'开始语音录制');
    $('send-button').disabled=state.busy; $('message-input').disabled=state.busy;
  }
  function scrollToEnd() { const el=$('chat-log'); el.scrollTop=el.scrollHeight; }
  function base64Url(base64) {const chars=atob(base64);const bytes=new Uint8Array(chars.length);for(let i=0;i<chars.length;i++) bytes[i]=chars.charCodeAt(i);return URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));}
  function addMessage(role,text,{tag,audioUrl,error=false}={}) {
    const welcome=$('welcome'); if(welcome)welcome.remove();
    const row=document.createElement('div');row.className='message '+(role==='user'?'from-user':'from-xixi')+(error?' message-error':'');
    const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=role==='user'?'你':'西';
    const content=document.createElement('div');content.className='message-content';
    const bubble=document.createElement('div');bubble.className='message-bubble';bubble.textContent=text;
    const meta=document.createElement('div');meta.className='message-meta';
    const clock=document.createElement('span');clock.textContent=time();meta.append(clock);
    if (tag) {const el=document.createElement('span');el.textContent=tag;meta.append(el);}
    content.append(bubble,meta);
    if(audioUrl){const audio=document.createElement('audio');audio.className='audio-attachment';audio.controls=true;audio.preload='metadata';audio.src=audioUrl;audio.addEventListener('loadedmetadata',()=>{}, {once:true});content.append(audio);}
    row.append(avatar,content);$('chat-log').append(row);scrollToEnd();
    return {bubble,row,content};
  }
  function addReplay(message,url){if(!url)return;const a=document.createElement('audio');a.className='audio-attachment';a.controls=true;a.preload='metadata';a.src=url;message.content.append(a);}
  function enqueueAudio(base64){if(!base64||!state.speak)return; state.audioQueue.push(base64);void playNext();}
  async function playNext(){if(state.playing||!state.audioQueue.length)return;state.playing=true;
    while(state.audioQueue.length){const base64=state.audioQueue.shift();const url=base64Url(base64);const audio=new Audio(url);state.audioNode=audio;
      try {await audio.play();await new Promise(resolve=>{state.audioEnd=resolve;audio.onended=resolve;audio.onerror=resolve;});}catch(e){logEvent('浏览器阻止自动播放，点击回复下方音频可重听');}finally{URL.revokeObjectURL(url);state.audioNode=null;state.audioEnd=null;}}
    state.playing=false;
  }
  function stopPlayback(){state.audioQueue.length=0;if(state.audioNode){state.audioNode.pause();state.audioNode.currentTime=0;}state.audioEnd?.();}
  function mockReply(input){const s=input.trim();if(s.includes('新闻')) return '我先挑你可能感兴趣的说。今天有几条值得留意的消息，不过这是演示内容，不是真新闻。连上真实服务后我再帮你查。';
    if(s.includes('提醒'))return '我听明白了，你想让我帮你记件事。这里是模拟界面，实际保存和到点提醒要连接西西服务后才会执行。';
    if(s.includes('镇上'))return '今天镇上这么热闹啊。你是正好碰上活动了，还是赶集的人多？';
    if(s.includes('累'))return '那今天还真是折腾。先坐会儿，喝口水，慢慢说。';
    return '嗯，我在听。你刚才说的这件事挺有意思，后来怎么样了？';
  }
  async function sendText(text) {
    if(state.busy||!text.trim())return;
    state.busy=true;updateUI();status('正在生成回复…',{busy:true});addMessage('user',text);state.turnCount++;logEvent('文本消息已发出');
    try {
      if(!live){await new Promise(r=>setTimeout(r,600));addMessage('xixi',mockReply(text),{tag:'模拟回复'});}
      else {const data=await request('/api/turn',{method:'POST',body:{text,speak:state.speak}});
        if(data.ok===false)throw new Error(data.error||'对话失败');
        if(data.accepted===false||data.action==='SILENCE')addMessage('xixi',data.silenceReasonLabel||'西西选择暂时不说话',{tag:'没有语音输出'});
        else {const r=addMessage('xixi',data.reply||((data.segments||[]).join('')||'（空回复）'),{tag:data.toolName?'使用工具 '+data.toolName:'回应你'});if(data.audio){addReplay(r,base64Url(data.audio));enqueueAudio(data.audio);}}
      }
    }catch(e){addMessage('xixi','刚才没接上：'+escapeError(e),{error:true});toast('发送失败：'+escapeError(e),true);logEvent('文本请求失败 '+escapeError(e));}
    finally {state.busy=false;updateUI();status('可以继续说话');$('message-input').focus();}
  }
  function wavBytes(samples,sampleRate){const buffer=new ArrayBuffer(44+samples.length*2);const v=new DataView(buffer);const txt=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i));};
    txt(0,'RIFF');v.setUint32(4,36+samples.length*2,true);txt(8,'WAVE');txt(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sampleRate,true);v.setUint32(28,sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);txt(36,'data');v.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++){const n=Math.min(1,Math.max(-1,samples[i]));v.setInt16(44+i*2,n<0?n*0x8000:n*0x7fff,true);}return new Uint8Array(buffer);}
  function toBase64(bytes){let b='';for(let i=0;i<bytes.length;i+=0x4000)b+=String.fromCharCode(...bytes.subarray(i,i+0x4000));return btoa(b);}
  async function beginRecording() {
    if(state.busy){toast('上一轮还在处理，稍等一下再按麦克风');return;}
    if(!live){state.recording=true;status('模拟录音中（不会访问麦克风）',{busy:true});logEvent('模拟录音开始');updateUI();return;}
    if(!navigator.mediaDevices?.getUserMedia){toast('浏览器需要 localhost 或 HTTPS 才能访问麦克风',true);return;}
    try {stopPlayback();const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      const ctx=new (window.AudioContext||window.webkitAudioContext)();await ctx.resume();const source=ctx.createMediaStreamSource(stream);const processor=ctx.createScriptProcessor(4096,1,1);const chunks=[];
      processor.onaudioprocess=(ev)=>chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
      source.connect(processor);processor.connect(ctx.destination);
      state.recorder={stream,ctx,source,processor,chunks,rate:ctx.sampleRate};state.recording=true;status('正在录音，点击麦克风发送',{busy:true});logEvent('麦克风录音开始');updateUI();
    }catch(e){toast('无法使用麦克风：'+escapeError(e),true);logEvent('麦克风授权失败');}
  }
  async function endRecording(){if(!state.recording)return;state.recording=false;updateUI();
    if(!live){addMessage('user','（模拟语音）今天去镇上，人真多。',{tag:'语音 · 模拟'});status('模拟识别完成');await new Promise(r=>setTimeout(r,450));addMessage('xixi',mockReply('今天去镇上，人真多。'),{tag:'模拟回复'});return;}
    const r=state.recorder;state.recorder=null;if(!r)return;r.processor.disconnect();r.source.disconnect();r.stream.getTracks().forEach(t=>t.stop());await r.ctx.close();
    const total=r.chunks.reduce((s,a)=>s+a.length,0);if(total<r.rate*.3){toast('录音太短，请再试一次');return;}
    const samples=new Float32Array(total);let offset=0;for(const part of r.chunks){samples.set(part,offset);offset+=part.length;}
    const bytes=wavBytes(samples,r.rate);const audioBase64=toBase64(bytes);const audioUrl=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
    const userMsg=addMessage('user','（语音正在识别）',{tag:'语音',audioUrl});
    state.busy=true;updateUI();status('正在识别并生成回复…',{busy:true});
    let responseText='';let stitched=null;
    try {
      const response=await fetch('/api/voice',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({audioBase64,speak:state.speak})});
      if(!response.ok)throw new Error('语音服务 '+response.status);
      if(!response.body)throw new Error('未收到语音流');
      const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
      const consume=ev=>{if(ev.type==='error')throw new Error(ev.error||'语音服务失败');
        if(ev.type==='clause'){enqueueAudio(ev.audio);}
        if(ev.type==='turn'){responseText=ev.reply||ev.text||'';const tr=ev.transcript||ev.recognizedText||ev.userText;if(tr)userMsg.bubble.textContent=tr;}
        if(ev.type==='end')stitched=ev.audio||null;
      };
      while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let idx;while((idx=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,idx).trim();buffer=buffer.slice(idx+1);if(line)consume(JSON.parse(line));}}
      if(buffer.trim())consume(JSON.parse(buffer.trim()));
      addMessage('xixi',responseText||'（西西本轮没有回复）',{tag:'语音回应',audioUrl:stitched?base64Url(stitched):null});state.turnCount++;logEvent('语音轮次完成');
    }catch(e){addMessage('xixi','语音出错了：'+escapeError(e),{error:true});toast('语音失败：'+escapeError(e),true);}
    finally{state.busy=false;updateUI();status('可以继续聊天');}
  }
  async function setProactive(on){if(live){await request('/api/proactive/settings',{method:'POST',body:{enabled:on}});await request('/api/proactive/loop',{method:'POST',body:{action:on?'start':'stop'}});}state.proactive=on;state.on=on;updateUI();logEvent(on?'主动陪伴已打开':'主动陪伴已关闭');}
  async function toggleCompanion(on){try{await setProactive(on);toast(on?'陪伴已开启，语音仍通过按键发起':'已暂停主动陪伴');}catch(e){toast(escapeError(e),true);updateUI();}}
  async function setTts(on){try{if(live)await request('/api/tts',{method:'POST',body:{enabled:on}});state.speak=on;if(!on)stopPlayback();updateUI();logEvent(on?'朗读已打开':'朗读已关闭');}catch(e){toast(escapeError(e),true);updateUI();}}
  async function toggleCamera(on){try{if(live){const data=await request('/api/camera',{method:'POST',body:{action:on?'start':'stop'}});state.camera=Boolean(data.status?.child?.running);}
      else state.camera=on;
      if(state.camera){$('camera-placeholder').querySelector('strong').textContent=live?'正在接收画面…':'模拟预览模式';$('camera-placeholder').querySelector('small').textContent=live?'请稍候':'不会连接真实设备';if(live){cameraFrame();if(!state.cameraTimer)state.cameraTimer=setInterval(cameraFrame,450);}}
      else {clearInterval(state.cameraTimer);state.cameraTimer=null;state.cameraInFlight=false;$('camera-image').style.display='none';$('camera-image').removeAttribute('src');$('camera-placeholder').style.display='flex';}
      updateUI();logEvent(on?'摄像头预览已打开':'摄像头预览已关闭');
    }catch(e){toast('摄像头操作失败：'+escapeError(e),true);logEvent('摄像头失败 '+escapeError(e));}}
  function cameraFrame(){if(!state.camera||state.cameraInFlight||!live)return;state.cameraInFlight=true;const img=$('camera-image');const src='/api/camera/frame.jpg?t='+Date.now();
    const temp=new Image();temp.onload=()=>{img.src=src;img.style.display='block';$('camera-placeholder').style.display='none';state.cameraInFlight=false;};
    temp.onerror=()=>{state.cameraInFlight=false;};temp.src=src;
  }
  async function syncLive(){if(!live)return;try{const info=await request('/api/state');state.turnCount=info.turnCount||state.turnCount;state.session=info.sessionId||null;$('info-provider').textContent=info.adapter?.provider||'未返回';$('info-store').textContent=info.database?.path||'—';
      if(info.recent?.length&&!$('chat-log').dataset.initialized){$('chat-log').dataset.initialized='1';for(const t of info.recent.slice(-10))if(t.text)addMessage(t.role==='user'?'user':'xixi',t.text,{tag:'历史'});}
      updateUI();logEvent('状态已同步：模型 '+$('info-provider').textContent+' · 轮数 '+state.turnCount);}
    catch(e){logEvent('无法连接当前 API：'+escapeError(e));toast('连接失败，请先启动 npm run web 再以 /demo/?mode=live 访问',true);}}
  async function pollLive(){if(!live)return;try{const [cam,loop]=await Promise.all([request('/api/camera'),request('/api/proactive/loop?cursor='+state.cursor)]);
      const previousCamera=state.camera;state.camera=cam.status?.child?.running===true;
      if(state.camera&&!previousCamera&&!state.cameraTimer){state.cameraTimer=setInterval(cameraFrame,450);cameraFrame();}
      if(!state.camera&&previousCamera){clearInterval(state.cameraTimer);state.cameraTimer=null;}
      const f=cam.status?.lastFrame;
      if(cam.problem){$('presence-label').textContent='摄像头不可用';$('camera-detail').textContent=cam.problem.title||'读取失败';}
      else if(f){$('presence-label').textContent=f.present?'画面里检测到有人':'画面里尚未检测到人';$('camera-detail').textContent='在场检测不等于识别身份 · '+(f.confidence?.toFixed(2)||'—');}
      else {$('presence-label').textContent='尚无有效画面';$('camera-detail').textContent='摄像头离线或正在启动';}
      state.cursor=loop.cursor||state.cursor;
      for(const e of (loop.entries||[])){if(e.speak&&e.text){const audio=e.audio?.find(a=>typeof a==='string')||null;const msg=addMessage('xixi',e.text,{tag:'主动开口'+(e.triggerLabel?' · '+e.triggerLabel:'')});if(audio)enqueueAudio(audio);logEvent('主动开口 '+(e.reasonLabel||e.trigger||''));}else logEvent('主动决策：'+(e.reasonLabel||'保持安静'));}
      state.proactive=Boolean(loop.status?.running);state.on=state.proactive;updateUI();
    }catch(e){logEvent('状态刷新失败：'+escapeError(e));}}
  function activateView(view){$('view-home').classList.toggle('hidden',view!=='home');$('view-lab').classList.toggle('hidden',view!=='lab');document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b.dataset.view===view));}
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>activateView(b.dataset.view)));
  $('settings-button').addEventListener('click',()=>activateView('lab'));$('return-home').addEventListener('click',()=>activateView('home'));
  $('companion-toggle').addEventListener('click',()=>void toggleCompanion(!state.on));
  $('proactive-switch').addEventListener('change',e=>void toggleCompanion(e.target.checked));
  $('tts-switch').addEventListener('change',e=>void setTts(e.target.checked));
  $('camera-toggle').addEventListener('click',()=>void toggleCamera(!state.camera));$('device-camera').addEventListener('click',()=>void toggleCamera(!state.camera));
  $('composer-form').addEventListener('submit',e=>{e.preventDefault();const t=$('message-input').value.trim();if(!t){status('先在输入框里打一句话，再按发送');$('message-input').focus();return;}$('message-input').value='';void sendText(t);});
  $('message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('composer-form').requestSubmit();}});
  document.querySelectorAll('[data-example]').forEach(btn=>btn.addEventListener('click',()=>{$('message-input').value=btn.dataset.example;$('message-input').focus();}));
  $('mic-button').addEventListener('click',()=>state.recording?void endRecording():void beginRecording());
  $('stop-playback').addEventListener('click',()=>{stopPlayback();toast('已经停止本页音频播放');logEvent('停止当前朗读');});
  $('clear-view').addEventListener('click',()=>{const log=$('chat-log');log.textContent='';log.dataset.initialized='1';toast('仅清空了当前画面，长期记忆没有删除');logEvent('清空当前界面');});
  $('quiet-button').addEventListener('click',async()=>{if(live){try{await request('/api/quiet',{method:'POST',body:{}});}catch(e){toast(escapeError(e),true);return;}}await toggleCompanion(false);toast('好，西西先安静一会儿');});
  $('refresh-info').addEventListener('click',()=>{if(live){void syncLive();return;}logEvent('模拟模式：没有真实服务可刷新，实验室里的数值来自本页状态');toast('模拟模式：没有真实服务可刷新');updateUI();});
  $('tick-button').addEventListener('click',async()=>{try{if(live){await request('/api/proactive/loop',{method:'POST',body:{action:'tick'}});await pollLive();}else logEvent('模拟主动决策：话题不够好，保持安静');toast('完成一次主动决策');}catch(e){toast('触发失败：'+escapeError(e),true);}});
  $('privacy-link').addEventListener('click',e=>{e.preventDefault();$('privacy-dialog').classList.remove('hidden');});
  $('close-privacy').addEventListener('click',()=>$('privacy-dialog').classList.add('hidden'));
  $('privacy-dialog').addEventListener('click',e=>{if(e.target===$('privacy-dialog'))$('privacy-dialog').classList.add('hidden');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')$('privacy-dialog').classList.add('hidden');});
  window.addEventListener('pagehide',()=>{clearInterval(state.cameraTimer);stopPlayback();state.recorder?.stream?.getTracks().forEach(t=>t.stop());});
  $('mode-pill').textContent=live?'● 已连接真实服务':'交互原型 · 模拟数据';$('mode-pill').classList.toggle('live',live);
  $('info-store').textContent=live?'读取中':'模拟内存'; $('info-provider').textContent=live?'读取中':'无真实模型';
  updateUI();void syncLive();if(live)setInterval(pollLive,1900);
  logEvent(live?'UI 已启动：连接真实西西服务':'UI 模拟模式：不会操作真实摄像头、麦克风或数据库');
})();
