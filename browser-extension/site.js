(() => {
  if(window.top!==window||location.origin!=="https://graceplanner.vercel.app")return;
  window.addEventListener("message",async(event)=>{
    const message=event.data;
    if(event.source!==window||event.origin!==location.origin||message?.channel!=="GRACE_SITE_V1")return;
    if(!["STATUS","BEGIN","FILE","COMMIT","ABORT"].includes(message.action))return;
    try{
      const payload={...message};
      if(message.action==="FILE"){
        if(!(message.file instanceof File)||message.file.size>40*1024*1024)throw new Error("Invalid file transfer.");
        const bytes=new Uint8Array(await message.file.arrayBuffer());const chunks=[];
        for(let i=0;i<bytes.length;i+=32768)chunks.push(String.fromCharCode(...bytes.subarray(i,i+32768)));
        payload.file={name:message.file.name,type:message.file.type,size:bytes.length,data:btoa(chunks.join(""))};
      }
      const result=await chrome.runtime.sendMessage(payload);
      window.postMessage({channel:"GRACE_EXTENSION_V1",id:message.id,callId:message.callId,reply:true,...result},location.origin);
    }catch(error){window.postMessage({channel:"GRACE_EXTENSION_V1",id:message.id,callId:message.callId,reply:true,error:error.message},location.origin);}
  });
  chrome.runtime.onMessage.addListener((message)=>{
    if(message.channel==="GRACE_EVENT_V1")window.postMessage({...message,channel:"GRACE_EXTENSION_V1"},location.origin);
  });
})();
