export function assertExternalActionsAllowed(): void {
  if (process.env.APP_ENV === 'staging') {
    throw new Error('External actions are disabled in isolated staging.');
  }
}
