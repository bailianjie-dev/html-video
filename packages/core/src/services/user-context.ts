export interface UserContext {
  userId: string;
  actorId: string;
}

export const LOCAL_DEV_USER_CONTEXT: UserContext = {
  userId: 'local-dev',
  actorId: 'local-dev',
};
