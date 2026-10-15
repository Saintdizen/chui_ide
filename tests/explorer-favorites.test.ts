import { describe, expect, it } from 'vitest';
import {
  addFavorite,
  isFavorite,
  MAX_FAVORITES,
  normalizeFavorites,
  removeFavorite,
  toggleFavorite,
} from '../src/shared/favorites';

/**
 * «Избранное» — постоянный список мест. Проверяем чистую модель: порядок, повторы,
 * снятие и разбор списка из настроек (файл могли править руками).
 */

describe('список избранного', () => {
  it('добавляет путь в конец: порядок — как добавлял человек', () => {
    const list = addFavorite(['/a'], '/b');
    expect(list).toEqual(['/a', '/b']);
  });

  it('повтор не двигает путь вверх', () => {
    const list = addFavorite(['/a', '/b'], '/a');
    expect(list).toEqual(['/a', '/b']);
  });

  it('пустой путь не попадает в список', () => {
    expect(addFavorite(['/a'], '   ')).toEqual(['/a']);
  });

  it('держит потолок', () => {
    const many = Array.from({ length: MAX_FAVORITES }, (_, index) => `/p/${index}`);
    const list = addFavorite(many, '/ещё');
    expect(list).toHaveLength(MAX_FAVORITES);
    expect(list).not.toContain('/ещё');
  });

  it('снимает и переключает', () => {
    expect(removeFavorite(['/a', '/b'], '/a')).toEqual(['/b']);
    expect(toggleFavorite(['/a'], '/a')).toEqual([]);
    expect(toggleFavorite(['/a'], '/b')).toEqual(['/a', '/b']);
    expect(isFavorite(['/a'], '/a')).toBe(true);
    expect(isFavorite(['/a'], '/b')).toBe(false);
  });
});

describe('разбор списка из настроек', () => {
  it('держит только непустые строки без повторов', () => {
    expect(normalizeFavorites(['/a', '', '  ', '/a', 7, null, '/b'])).toEqual(['/a', '/b']);
  });

  it('не-массив читается как пустой список', () => {
    expect(normalizeFavorites(undefined)).toEqual([]);
    expect(normalizeFavorites('что-то')).toEqual([]);
  });

  it('потолок применяется и при чтении', () => {
    const many = Array.from({ length: MAX_FAVORITES + 10 }, (_, index) => `/p/${index}`);
    expect(normalizeFavorites(many)).toHaveLength(MAX_FAVORITES);
  });
});
