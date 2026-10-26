// Copyright (c) 2026 FPVSkyline. MIT License.

#include "Editor/Html2UMGOptions.h"

#define LOCTEXT_NAMESPACE "Html2UMGOptions"

UHtml2UMGImportOptions::UHtml2UMGImportOptions()
	: AssetOutputRoot(TEXT("/Game/Html2UMG"))
	, bImportTextures(true)
	, bImportFonts(true)
	, bReimportInPlace(true)
	, bCompile(true)
	, bSave(true)
	, UIScale(1.0f)
	, ViewportWidth(1920)
	, ViewportHeight(1080)
{
}

FH2UImportOptions UHtml2UMGImportOptions::ToImportOptions() const
{
	FH2UImportOptions Options;
	Options.BlueprintPath = BlueprintPath;
	Options.ParentClassPath = ParentClassPath;
	Options.AssetOutputRoot = AssetOutputRoot.IsEmpty() ? FH2UImportOptions().AssetOutputRoot : AssetOutputRoot;
	Options.bImportTextures = bImportTextures;
	Options.bImportFonts = bImportFonts;
	Options.bReimportInPlace = bReimportInPlace;
	Options.bCompile = bCompile;
	Options.bSave = bSave;
	Options.UIScale = UIScale > KINDA_SMALL_NUMBER ? UIScale : 1.0f;
	return Options;
}

FVector2D UHtml2UMGImportOptions::GetViewportSize() const
{
	return FVector2D(
		FMath::Max(64, ViewportWidth),
		FMath::Max(64, ViewportHeight));
}

#undef LOCTEXT_NAMESPACE
