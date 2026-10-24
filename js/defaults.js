// Starting categories. Fixed ids so a fresh install and a backup agree.
// Users can rename, add, delete and reorder these in Settings.
export const DEFAULT_CATEGORIES = [
  { id: 'appetizers', name: 'Appetizers', emoji: '🥟', parentId: null, order: 0 },

  { id: 'desserts', name: 'Desserts', emoji: '🍰', parentId: null, order: 1 },
  { id: 'desserts-cakes', name: 'Cakes', emoji: '🎂', parentId: 'desserts', order: 0 },
  { id: 'desserts-cookies', name: 'Cookies', emoji: '🍪', parentId: 'desserts', order: 1 },
  { id: 'desserts-breads', name: 'Breads', emoji: '🍞', parentId: 'desserts', order: 2 },
  { id: 'desserts-other', name: 'Other', emoji: '🍮', parentId: 'desserts', order: 3 },

  { id: 'meals', name: 'Meals', emoji: '🍽️', parentId: null, order: 2 },
  { id: 'meals-chicken', name: 'Chicken', emoji: '🍗', parentId: 'meals', order: 0 },
  { id: 'meals-beef', name: 'Beef', emoji: '🥩', parentId: 'meals', order: 1 },
  { id: 'meals-soups', name: 'Soups', emoji: '🍲', parentId: 'meals', order: 2 },
  { id: 'meals-other', name: 'Other', emoji: '🥘', parentId: 'meals', order: 3 },
];

// Model presets per provider. The first entry is the default.
// Any model id can also be typed in Settings.
export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    models: [
      'deepseek/deepseek-v4.1-flash-1017',
      'deepseek/deepseek-v4.1-flash',
      'anthropic/claude-haiku-5.5',
      'anthropic/claude-sonnet-5.5',
    ],
  },
  deepinfra: {
    label: 'DeepInfra',
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    models: [
      'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      'deepseek-ai/DeepSeek-V4.1-Flash',
      'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    ],
  },
  anthropic: {
    label: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ],
  },
};
