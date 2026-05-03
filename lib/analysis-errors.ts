export function analysisErrorTitle(error: string | null | undefined): string {
  if (error === "insufficient_source") return "書誌情報不足";
  return "解析エラー";
}

export function analysisErrorMessage(error: string | null | undefined): string {
  if (error === "insufficient_source") {
    return "説明文・目次・メモが不足しているため、ハルシネーション防止のため解析を停止しました。メモに目次や要約を追加してから再解析してください。";
  }

  return error ?? "原因不明のエラーです。";
}
