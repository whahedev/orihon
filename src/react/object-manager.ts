import { useLayoutEffect, useRef, useState } from "react";
import {
  ObjectManager as OrihonObjectManager,
  objectManager,
  type ManagedObject,
  type ObjectFilter,
  type ObjectId,
  type ObjectManagerOptions
} from "../services/object-manager.js";
import { useMap } from "./context.js";

export interface ObjectManagerProps extends ObjectManagerOptions {
  objects: Array<ManagedObject & { id: ObjectId }>;
  filter?: ObjectFilter | null;
  onReady?: (manager: OrihonObjectManager) => void;
}

export function ObjectManager({ objects, filter = null, onReady, ...options }: ObjectManagerProps) {
  const map = useMap();
  const [manager, setManager] = useState<OrihonObjectManager | null>(null);
  const previous = useRef(new globalThis.Map<ObjectId, ManagedObject>());

  useLayoutEffect(() => {
    const instance = objectManager(options);
    instance.addTo(map);
    previous.current = new globalThis.Map();
    setManager(instance);
    onReady?.(instance);
    return () => { instance.destroy(); };
  }, [map]);

  useLayoutEffect(() => {
    if (!manager || manager.isDestroyed) return;
    const next = new globalThis.Map<ObjectId, ManagedObject>();
    const additions: ManagedObject[] = [];
    const updates: ManagedObject[] = [];
    for (const object of objects) {
      next.set(object.id, object);
      if (!previous.current.has(object.id)) additions.push(object);
      else if (previous.current.get(object.id) !== object) updates.push(object);
    }
    const removals = [...previous.current.keys()].filter((id) => !next.has(id));
    if (removals.length) manager.removeObjects(removals);
    if (additions.length) manager.add(additions);
    if (updates.length) manager.update(updates);
    previous.current = next;
  }, [manager, objects]);

  useLayoutEffect(() => { if (manager && !manager.isDestroyed) manager.setFilter(filter); }, [manager, filter]);
  return null;
}
