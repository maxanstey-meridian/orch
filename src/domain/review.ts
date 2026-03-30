export const shouldReview = (stats: { total: number }, threshold = 30): boolean =>
  stats.total >= threshold;
