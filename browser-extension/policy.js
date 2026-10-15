export const SITE = "https://graceplanner.vercel.app";
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
export function isSite(url) {try{return new URL(url).origin===SITE;}catch{return false;}}
export function isChat(url) {try{const u=new URL(url);return u.origin==="https://chatgpt.com"&&!u.pathname.startsWith("/share/");}catch{return false;}}
export function conversationUrl(url) {
  try {
    const u=new URL(url);
    if(u.origin!=="https://chatgpt.com"||!/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9_-]{8,100}\/?$/.test(u.pathname))return null;
    return u.origin+u.pathname.replace(/\/$/,"");
  }catch{return null;}
}
export function validId(id) {return typeof id==="string"&&/^[a-zA-Z0-9_-]{8,100}$/.test(id);}
export function validateRequest(message) {
  if(!validId(message.id)||!validId(message.chatId)) throw new Error("Invalid chat binding.");
  if(typeof message.text!=="string"||message.text.length>100000)throw new Error("Message is too long.");
  if(!Array.isArray(message.files)||message.files.length>10)throw new Error("Upload a ZIP for more than 10 files.");
  let total=0;
  for(const file of message.files){
    if(!file||typeof file.name!=="string"||file.name.length>255||!Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_FILE_BYTES)throw new Error("Invalid attachment size or name.");
    if(!["image/jpeg","image/png","image/webp","application/zip"].includes(file.type))throw new Error("Only images and ZIP are supported.");
    total+=file.size;
  }
  if(total>MAX_TOTAL_BYTES)throw new Error("Attachments exceed 120 MiB.");
}
