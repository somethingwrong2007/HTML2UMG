// Copyright (c) 2026 FPVSkyline. MIT License.

#pragma once

#include "CoreMinimal.h"
#include "Html2UMGTypes.h"

#include "Html2UMGBlueprintTypes.generated.h"

/**
 * Blueprint/Python friendly mirror of FH2UImportResult (the importer struct itself is
 * a plain C++ type and cannot cross the reflection boundary).
 *
 * Python note: UE strips the leading "b" of bool properties, so `bSuccess` is `success`
 * from unreal python, while Blueprint pins show "Success".
 */
USTRUCT(BlueprintType)
struct HTML2UMG_API FH2UImportResultBP
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Html2UMG")
	bool bSuccess = false;

	UPROPERTY(BlueprintReadOnly, Category = "Html2UMG")
	int32 WidgetsCreated = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Html2UMG")
	int32 WidgetsReused = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Html2UMG")
	int32 PropertiesSet = 0;

	UPROPERTY(BlueprintReadOnly, Category = "Html2UMG")
	FString BlueprintPath;

	/** One entry per importer message, already prefixed with its severity ("[error] ..."). */
	UPROPERTY(BlueprintReadOnly, Category = "Html2UMG")
	TArray<FString> Messages;

	/** Copies an importer result into this struct. */
	void FromResult(const FH2UImportResult& InResult);

	/** Returns a filled copy of an importer result. */
	static FH2UImportResultBP MakeFromResult(const FH2UImportResult& InResult);

	/** Fails this result with a single error message. */
	void SetError(const FString& InMessage);

	/** Single string for logs: one message per line. */
	FString ToText() const;
};
