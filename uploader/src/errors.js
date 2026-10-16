// An error that is safe to show to the client: `code` is machine-readable,
// `message` is plain language for the person holding the phone.
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
