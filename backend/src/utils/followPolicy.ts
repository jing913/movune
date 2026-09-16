type IdValue = {
  toString(): string
}

export const isSelfFollow = (followerId: IdValue, followingId: IdValue) =>
  followerId.toString() === followingId.toString()
