// "Turn N" for the Activity Feed: the number of player messages in the chat. Stable across
// reloads and event-ring trimming, unlike counting generations seen so far.
export function userTurnNumber(chat){
  const rows=Array.isArray(chat)?chat:[];
  let count=0;
  for(const row of rows)if(row?.is_user===true)count+=1;
  return count;
}
