import * as vscode from "vscode";
import {
  IMAGE_PASTE_DIRECTORY,
  IMAGE_PASTE_MIME_TYPES,
  imagePasteExtension,
  imagePasteInsertText,
  nextImagePasteFileName,
} from "./image-paste";

/**
 * Cmd/Ctrl+V でクリップボードの画像を `assets/` に保存し、カーソル位置に参照を挿入する(#153)。
 * 保存と挿入は 1 つの paste edit なので、1 回の undo で両方戻る。
 */
export class ImagePasteEditProvider implements vscode.DocumentPasteEditProvider {
  static readonly kind = vscode.DocumentDropOrPasteEditKind.Empty.append("latex", "image");
  static readonly metadata: vscode.DocumentPasteProviderMetadata = {
    providedPasteEditKinds: [ImagePasteEditProvider.kind],
    pasteMimeTypes: IMAGE_PASTE_MIME_TYPES,
  };

  async provideDocumentPasteEdits(
    document: vscode.TextDocument,
    ranges: readonly vscode.Range[],
    dataTransfer: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    if (document.uri.scheme !== "file") return undefined;
    const image = firstImage(dataTransfer);
    if (!image) return undefined;
    const directory = vscode.Uri.joinPath(document.uri, "..", IMAGE_PASTE_DIRECTORY);
    const existing = new Set((await listDirectory(directory)).map(([name]) => name));
    const data = await image.file.data();
    if (token.isCancellationRequested) return undefined;
    const name = nextImagePasteFileName(image.extension, (candidate) => existing.has(candidate));
    const relativePath = `${IMAGE_PASTE_DIRECTORY}/${name}`;
    const offset = document.offsetAt(ranges[0]?.start ?? new vscode.Position(0, 0));
    const edit = new vscode.DocumentPasteEdit(
      imagePasteInsertText(document.getText(), offset, relativePath),
      `画像を ${relativePath} に保存して挿入`,
      ImagePasteEditProvider.kind,
    );
    edit.additionalEdit = new vscode.WorkspaceEdit();
    edit.additionalEdit.createFile(vscode.Uri.joinPath(directory, name), { contents: data });
    return [edit];
  }
}

function firstImage(
  dataTransfer: vscode.DataTransfer,
): { file: vscode.DataTransferFile; extension: string } | undefined {
  for (const mimeType of IMAGE_PASTE_MIME_TYPES) {
    const file = dataTransfer.get(mimeType)?.asFile();
    const extension = imagePasteExtension(mimeType);
    if (file && extension) return { file, extension };
  }
  return undefined;
}

/** `assets/` が無ければ空。ディレクトリは createFile が作る。 */
async function listDirectory(directory: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return [];
  }
}
