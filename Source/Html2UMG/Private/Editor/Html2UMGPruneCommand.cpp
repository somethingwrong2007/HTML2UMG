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
		// Dry run unless "force" is passed. The registry's referencers do not include the UObject
		// links a widget's brush holds (that deleted a Slider's bitmap once and made the control
		// render nothing), so deleting on this signal alone has to be an explicit decision.
		bool bForce = false;
		TArray<FString> Positional;
		for (const FString& Arg : Args)
		{
			if (Arg.Equals(TEXT("force"), ESearchCase::IgnoreCase) || Arg.Equals(TEXT("--force"), ESearchCase::IgnoreCase))
			{
				bForce = true;
			}
			else if (!Arg.StartsWith(TEXT("-")))
			{
				Positional.Add(Arg);
			}
		}

		FString Folder = Positional.Num() > 0 ? Positional[0] : TEXT("/Game/Html2UMG");
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

		if (!bForce)
		{
			UE_LOG(LogHtml2UMG, Display,
				TEXT("Html2UMG.PruneAssets: %d candidate(s) of %d under '%s' have no registry referencers (%s%s). Nothing was deleted; pass 'force' to delete them."),
				ToDelete.Num(), Assets.Num(), *Folder,
				*FString::Join(Names, TEXT(", ")).Left(200), Names.Num() > 6 ? TEXT(", ...") : TEXT(""));
			return;
		}

		const int32 Deleted = ObjectTools::DeleteObjectsUnchecked(ToDelete);
		UE_LOG(LogHtml2UMG, Display,
			TEXT("Html2UMG.PruneAssets: %d orphaned asset(s) of %d under '%s' deleted (%s%s)."),
			Deleted, Assets.Num(), *Folder, *FString::JoinBy(Names, TEXT(", "), [](const FString& Name) { return Name; }).Left(200),
			Names.Num() > 6 ? TEXT(", ...") : TEXT(""));
	}

	/**
	 * Html2UMG.DeleteAsset <path> [<path> ...]
	 *
	 * Deletes the named assets outright.
	 *
	 * PruneAssets is the safe default, but it cannot remove a *duplicate*: when a page has been
	 * imported twice under two paths, each copy is referenced by nothing, so the user still has to say
	 * which one is the leftover. This is that "say it" command - no registry guesswork.
	 */
	void DeleteAssetCommand(const TArray<FString>& Args)
	{
		if (Args.Num() == 0)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Usage: Html2UMG.DeleteAsset <path> [<path> ...]"));
			return;
		}

		TArray<UObject*> ToDelete;
		TArray<FString> Missing;
		for (const FString& Arg : Args)
		{
			FString Path = Arg.TrimStartAndEnd();
			if (!Path.StartsWith(TEXT("/")))
			{
				Path = TEXT("/Game/") + Path;
			}
			UObject* Asset = LoadObject<UObject>(nullptr, *Path);
			if (!Asset)
			{
				// Accept a package path without the object name: "/Game/UI/WBP_Foo" -> "...WBP_Foo".
				const FString ShortName = FPackageName::GetShortName(Path);
				Asset = LoadObject<UObject>(nullptr, *FString::Printf(TEXT("%s.%s"), *Path, *ShortName));
			}
			if (Asset)
			{
				ToDelete.Add(Asset);
			}
			else
			{
				Missing.Add(Path);
			}
		}

		if (ToDelete.Num() > 0)
		{
			const int32 Deleted = ObjectTools::DeleteObjectsUnchecked(ToDelete);
			UE_LOG(LogHtml2UMG, Display, TEXT("Html2UMG.DeleteAsset: deleted %d asset(s)."), Deleted);
		}
		if (Missing.Num() > 0)
		{
			UE_LOG(LogHtml2UMG, Warning, TEXT("Html2UMG.DeleteAsset: could not load %s"),
				*FString::Join(Missing, TEXT(", ")));
		}
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

			IConsoleManager::Get().RegisterConsoleCommand(
				TEXT("Html2UMG.DeleteAsset"),
				TEXT("Deletes the named assets. Usage: Html2UMG.DeleteAsset <path> [<path> ...]"),
				FConsoleCommandWithArgsDelegate::CreateStatic(&DeleteAssetCommand),
				ECVF_Default);
		}
	};

	static FPruneAssetsRegistration GPruneAssetsRegistration;

	/** Lets the command be registered without a module startup hook of its own. */
	void EnsurePruneCommandLinked() {}
}
