/** A UniFi response did not have the expected shape or values. */
export class UnifiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnifiResponseError';
  }
}
