const cancelledBookIds = new Set<number>();

export function requestCancellation(bookId: number) {
  cancelledBookIds.add(bookId);
}

export function isCancellationRequested(bookId: number) {
  return cancelledBookIds.has(bookId);
}

export function clearCancellation(bookId: number) {
  cancelledBookIds.delete(bookId);
}
