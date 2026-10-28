// Copyright (c) 2026 FPVSkyline. MIT License.

#include "CoreMinimal.h"
#include "HAL/IConsoleManager.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetToolsModule.h"
#include "ObjectTools.h"
#include "Modules/ModuleManager.h"
#include "Html2UMGLog.h"

namespace
{
	/**
	 * Html2UMG.PruneAssets [<folder>]
	 *
	 * Deletes every asset under the folder that nothing references.
	 *
	 * A conversion writes a page's bitmaps into its own folder, so re-converting a page whose CSS no
	 * longer uses an image leaves the old bitmap behind: valid, saved, and never used again. Deleting
	 * assets by hand is the kind of chore that ends with deleting the wrong one, so the rule here is
	 * the asset registry's own: zero referencers means nothing in the project can break.
	 *
	 * Default folder is /Game/Html2UMG (where the importer puts every generated asset).
	 */
	void PruneAssetsCommand(const TArray<FString>& Args)
	{
		FString Folder = Args.Num() > 0 ? Args[0] : TEXT("/Game/Html2UMG");
		if (!Folder.StartsWith(TEXT("/")))
		{
			Folder = TEXT("/Game/") + Folder;
		}

		FAssetRegistryModule& AssetRegistryModule =
			FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();

		TArray<FAssetData> Assets;
		AssetRegistry.GetAssetsByPath(FName(*Folder), Assets, /*bRecursive=*/true, /*bIncludeOnlyOnDiskAssets=*/false);

		TArray<UObject*> ToDelete;
		TArray<FString> Names;
		for (const FAssetData& Asset : Assets)
		{
			TArray<FName> Referencers;
			AssetRegistry.GetReferencers(Asset.PackageName, Referencers);
			if (Referencers.Num() > 0)
			{
				continue;
			}
			if (UObject* Loaded = Asset.GetAsset())
			{
				ToDelete.Add(Loaded);
				Names.Add(Asset.AssetName.ToString());
			}
		}

		if (ToDelete.Num() == 0)
		{
			UE_LOG(LogHtml2UMG, Display,
				TEXT("Html2UMG.PruneAssets: %d asset(s) under '%s', all referenced - nothing to delete."),
				Assets.Num(), *Folder);
			return;
		}

		const int32 Deleted = ObjectTools::DeleteObjectsUnchecked(ToDelete);
		UE_LOG(LogHtml2UMG, Display,
			TEXT("Html2UMG.PruneAssets: %d orphaned asset(s) of %d under '%s' deleted (%s%s)."),
			Deleted, Assets.Num(), *Folder, *FString::JoinBy(Names, TEXT(", "), [](const FString& Name) { return Name; }).Left(200),
			Names.Num() > 6 ? TEXT(", ...") : TEXT(""));
	}

	struct FPruneAssetsRegistration
	{
		FPruneAssetsRegistration()
		{
			IConsoleManager::Get().RegisterConsoleCommand(
				TEXT("Html2UMG.PruneAssets"),
				TEXT("Deletes assets under a folder that nothing references. Usage: Html2UMG.PruneAssets [/Game/Html2UMG]"),
				FConsoleCommandWithArgsDelegate::CreateStatic(&PruneAssetsCommand),
				ECVF_Default);
		}
	};

	static FPruneAssetsRegistration GPruneAssetsRegistration;

	/** Lets the command be registered without a module startup hook of its own. */
	void EnsurePruneCommandLinked() {}
}
