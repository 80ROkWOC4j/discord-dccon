import type {PluginEvent, EventListener} from './types.ts';
export function createEvents() {
  const eventListeners = new Map<string, Set<EventListener>>();
  const PluginEvents = {
    subscribe(type: string, listener: EventListener) {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type)!.add(listener);
    },
    unsubscribe(type: string, listener: EventListener) {
      const listeners = eventListeners.get(type);
      listeners?.delete(listener);
      if (listeners?.size === 0) eventListeners.delete(type);
    },
    dispatch(event: PluginEvent) {
      for (const listener of [...(eventListeners.get(event.type) ?? [])]) {
        listener(event);
      }
    },
  };

  return PluginEvents;
}
export type Events = ReturnType<typeof createEvents>;
