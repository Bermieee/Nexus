function clean(value){return String(value??'').trim();}
export function invalidSceneHydrationRow(message){
  if(!message||message.is_system===true||!clean(message.mes))return true;
  const extra=message.extra&&typeof message.extra==='object'?message.extra:{};
  return message.rejected===true
    || extra.tv2_rejected_generation===true
    || extra.tv2_generation_rejected===true
    || extra.tv2_generation_incomplete===true
    || extra.tv2_generation_failed===true
    || extra.tv2_postturn_skip===true
    || extra.tv2_transport_only===true
    || extra.transport_only===true;
}
export function sceneHydrationMessages(messages=[],limit=10){
  return (Array.isArray(messages)?messages:[]).map((message,index)=>({message,index}))
    .filter(({message})=>!invalidSceneHydrationRow(message))
    .slice(-Math.max(1,Number(limit)||10))
    .map(({message,index})=>({index,role:message.is_user===true?'user':'assistant',text:clean(message.mes),messageId:clean(message?.extra?.tv2_message_id)||String(index)}));
}
