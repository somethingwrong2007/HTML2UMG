// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "Html2UMGTypes.h"

#include "Html2UMGOptions.generated.h"

/**
 * UObject mirror of FH2UImportOptions so the options can be exposed to Blueprints,
 * Python, the Slate panel and the details view.
 *
 * The plain struct stays the importer's contract (see Importer/Html2UMGImporter.h);
 * this class only exists at the editor boundary. Use ToImportOptions() to cross it.
 *
 * Note for Python users: UE's python binding strips the "b" prefix of bool
 * properties, so `bImportTextures` is written `import_textures` there (and
 * `bSuccess` on FH2UImportResultBP becomes `success`).
 */
UCLASS(BlueprintType)
class HTML2UMG_API UHtml2UMGImportOptions : public UObject
{
	GENERATED_BODY()

public:
	UHtml2UMGImportOptions();

	/** Target Widget Blueprint, e.g. /Game/UI/WBP_Design. Empty = take it from the layout json. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	FString BlueprintPath;

	/** Optional parent class override, e.g. /Script/MyGame.MyBaseWidget. Empty = take it from the json. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	FString ParentClassPath;

	/** Content root for textures/fonts imported from the layout. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	FString AssetOutputRoot;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	bool bImportTextures;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	bool bImportFonts;

	/** Rebuild an existing blueprint's widget tree in place (keeps graphs and BindWidget bindings). */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	bool bReimportInPlace;

	/** Compile the blueprint after import. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	bool bCompile;

	/** Save the package after import. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG")
	bool bSave;

	/** Design pixel -> UMG pixel multiplier applied to sizes and offsets. */
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG", meta = (ClampMin = "0.01", UIMin = "0.5", UIMax = "4.0"))
	float UIScale;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG", meta = (ClampMin = "64", UIMin = "320", UIMax = "7680"))
	int32 ViewportWidth;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Html2UMG", meta = (ClampMin = "64", UIMin = "240", UIMax = "4320"))
	int32 ViewportHeight;

	/** Convert to the importer-facing struct. */
	FH2UImportOptions ToImportOptions() const;

	/** Viewport as a vector, clamped to something renderable. */
	FVector2D GetViewportSize() const;
};
