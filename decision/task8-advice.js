import { clearWorkingState, readWorkingState, writeWorkingState } from '../core/ephemeral-state.js';

export const TASK8_ADVICE_KIND='TASK8_POSTTURN_ADVICE';
const chatIdOf=context=>context?.chatId??context?.chat_id??null;

export function readTask8PostTurnAdvice({context=null,chatId=chatIdOf(context)}={}){
  if(chatId==null)return null;
  return readWorkingState(TASK8_ADVICE_KIND,String(chatId));
}
export function writeTask8PostTurnAdvice(value,{context=null,chatId=chatIdOf(context)}={}){
  if(chatId==null)return null;
  writeWorkingState(TASK8_ADVICE_KIND,String(chatId),value);
  return value;
}
export function clearTask8PostTurnAdvice({context=null,chatId=chatIdOf(context)}={}){
  if(chatId==null)return false;
  clearWorkingState(TASK8_ADVICE_KIND,String(chatId));
  return true;
}
