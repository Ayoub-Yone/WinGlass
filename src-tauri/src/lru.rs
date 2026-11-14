//! Small bounded least-recently-used cache (string keys, a few dozen entries).

use std::collections::HashMap;

pub struct LruCache<V> {
    capacity: usize,
    tick: u64,
    entries: HashMap<String, (V, u64)>,
}

impl<V: Clone> LruCache<V> {
    pub fn new(capacity: usize) -> Self {
        Self { capacity: capacity.max(1), tick: 0, entries: HashMap::with_capacity(capacity.max(1)) }
    }

    /// Clone of the cached value; marks it most recently used.
    pub fn get(&mut self, key: &str) -> Option<V> {
        self.tick += 1;
        let tick = self.tick;
        self.entries.get_mut(key).map(|(value, used)| {
            *used = tick;
            value.clone()
        })
    }

    /// Insert or replace, evicting the least recently used entry when full.
    pub fn insert(&mut self, key: String, value: V) {
        self.tick += 1;
        if !self.entries.contains_key(&key) && self.entries.len() >= self.capacity {
            if let Some(oldest) = self.entries.iter().min_by_key(|(_, (_, used))| *used).map(|(k, _)| k.clone()) {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (value, self.tick));
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::LruCache;

    #[test]
    fn never_grows_past_capacity() {
        let mut cache = LruCache::new(64);
        for i in 0..500 {
            cache.insert(format!("icon-{i}"), i);
        }
        assert_eq!(cache.len(), 64);
        assert_eq!(cache.get("icon-499"), Some(499));
        assert_eq!(cache.get("icon-0"), None);
    }

    #[test]
    fn evicts_the_least_recently_used_entry() {
        let mut cache = LruCache::new(2);
        cache.insert("a".into(), 1);
        cache.insert("b".into(), 2);
        assert_eq!(cache.get("a"), Some(1)); // "b" is now the oldest
        cache.insert("c".into(), 3);
        assert_eq!(cache.get("b"), None);
        assert_eq!(cache.get("a"), Some(1));
        assert_eq!(cache.get("c"), Some(3));
    }

    #[test]
    fn replacing_a_key_does_not_evict() {
        let mut cache = LruCache::new(2);
        cache.insert("a".into(), 1);
        cache.insert("b".into(), 2);
        cache.insert("a".into(), 10);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("a"), Some(10));
        assert_eq!(cache.get("b"), Some(2));
    }
}
