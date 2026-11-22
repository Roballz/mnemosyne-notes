import { getSettings, saveSettings } from './store.js';
import { nextReminder } from './model.js';
const states=new Map();
export function updateReminderState(key,patch){
    const saved=states.get(key);if(saved?.value)Object.assign(saved.value,patch);
}
export async function archiveReminder(key,lastFloor){
    if(!key||lastFloor<50)return null;
    let state=states.get(key);
    if(!state){
        state={value:null,pending:null};states.set(key,state);
        if(states.size>16)states.delete(states.keys().next().value);
        state.pending=getSettings(key).then(value=>state.value=value);
    }
    await state.pending;
    const value=state.value,archived=value.archivedFloor||0;
    const milestone=nextReminder(archived,lastFloor,value.remindedAt||0);
    if(milestone==null)return null;
    // Claim in memory before the IDB await; MESSAGE_RECEIVED and GENERATION_ENDED
    // can fire together but must not produce two bubbles.
    value.remindedAt=milestone;
    await saveSettings(key,{remindedAt:milestone});
    return {milestone,archived,lastFloor};
}
