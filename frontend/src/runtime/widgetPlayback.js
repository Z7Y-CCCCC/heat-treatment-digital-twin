import { onMounted,onBeforeUnmount,onActivated,onDeactivated,ref } from 'vue'
export function useWidgetClock() {
  const now=ref(Date.now());let timer=0
  const stop=()=>{clearInterval(timer);timer=0}
  const start=()=>{stop();now.value=Date.now();timer=setInterval(()=>{now.value=Date.now()},100)}
  onMounted(start);onActivated(start);onDeactivated(stop);onBeforeUnmount(stop)
  return now
}
