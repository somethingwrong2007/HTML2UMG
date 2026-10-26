// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Html2UMGTypes.h"
#include "Importer/Html2UMGPropertyApplier.h"
#include "Templates/Function.h"

class UPackage;
class UFont;
class UObject;
class UTexture2D;

/**
 * Imports (or reuses) the textures and fonts declared in a layout's "assets" block,
 * and resolves layout references ("@key", "/Game/...", raw file paths) to loaded UObjects.
 *
 * Everything it does is idempotent: importing the same layout twice reuses / overwrites the
 * same assets instead of leaving "_1" duplicates behind.
 */
class HTML2UMG_API FHtml2UMGAssetImport
{
public:
	FHtml2UMGAssetImport(const FH2ULayout& InLayout, const FH2UImportOptions& InOptions);

	/** Imports everything the layout declares. Errors are reported through the sink. */
	bool ImportAll(const FH2UMessageSink& Sink);

	/**
	 * Reference resolver handed to the reflection writer.
	 * "@key" -> texture/font import, "/Game/..." -> LoadObject, anything else -> file path import.
	 */
	UObject* Resolve(const FString& Reference, UClass* ExpectedClass, const FString& Context);

	/** Number of texture assets this import created (vs. reused). */
	int32 TexturesImported = 0;
	int32 TexturesReused = 0;
	int32 FontsImported = 0;
	int32 FontsReused = 0;

	/** Packages that were created or modified and should be saved at the end of the import. */
	const TArray<UPackage*>& GetTouchedPackages() const { return TouchedPackages; }

	/** Errors seen while importing; the importer folds these into the result. */
	const TArray<FH2UMessage>& GetMessages() const { return Messages; }

private:
	/** Imports (or finds) the texture for a "@key" entry. */
	UTexture2D* EnsureTexture(const FString& Key, const FString& Context);

	/** Imports (or finds) the UFont for a "@key" font entry; null when the entry has no file. */
	UFont* EnsureFont(const FString& Key, const FString& Context);

	/** Adds one typeface (Regular/Bold/...) to the family font, creating the family asset if needed. */
	bool AddTypeface(const FH2UAssetRef& Ref, const FString& Context);

	/** Imports a TTF/OTF into a UFontFace asset, reusing it when it is already up to date. */
	UObject* ImportFontFace(const FH2UAssetRef& Ref, const FString& AbsFile, const FString& Context);

	/** Imports an image file into a UTexture2D asset, reusing it when it is already up to date. */
	UTexture2D* ImportTextureFile(const FString& Key, const FString& AbsFile, const FString& Context);

	/** "/Game/UI/Foo/T_Bar" -> existing asset or null. */
	UObject* FindExistingAsset(const FString& PackagePath, const FString& AssetName) const;

	FString MakeAssetName(const FString& InRaw) const;

	void Message(const FH2UMessageSink& Sink, const TCHAR* Severity, const FString& Text);

	/** Typeface entry name for a weight/italic combination. */
	static FString TypefaceNameFor(const FH2UAssetRef& Ref);

	const FH2ULayout& Layout;
	const FH2UImportOptions& Options;

	FString OutputRoot;

	/** "@tex_N" -> texture. */
	TMap<FString, TObjectPtr<UTexture2D>> TextureCache;
	/** family (lower-case) -> font family asset. */
	TMap<FString, TObjectPtr<UFont>> FontCache;
	/** "@font_N" -> font family asset. */
	TMap<FString, TObjectPtr<UFont>> FontKeyCache;
	/** absolute file -> imported asset, so the same file is imported once. */
	TMap<FString, TWeakObjectPtr<UObject>> FileCache;

	TSet<FString> ReportedMissing;

	TArray<UPackage*> TouchedPackages;
	TArray<FH2UMessage> Messages;
	FH2UMessageSink ActiveSink;
	bool bHasErrors = false;
};
