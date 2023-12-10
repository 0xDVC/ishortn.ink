"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@clerk/nextjs";
import { Prisma } from "@prisma/client";

import { generateShortUrl } from "@/app/api/utils/links";
import prisma from "@/db";
import { generateShortLinkForProject } from "@/lib/utils";

export const createLink = async (link: Prisma.LinkCreateInput) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  const existingLink = await prisma.link.findUnique({
    where: {
      alias: link.alias,
    },
  });

  if (existingLink) {
    return {
      error: "Alias already exists, please enter another one",
    };
  }

  const createdLink = prisma.link.create({
    data: {
      ...link,
      alias: link.alias || (await generateShortUrl(link.url)),
      User: {
        connect: {
          id: userId,
        },
      },
    },
  });
  revalidatePath("/dashboard");
  return createdLink;
};

export const quickLinkShorten = async (url: string) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  const createdLink = prisma.link.create({
    data: {
      url,
      alias: await generateShortUrl(url),
      User: {
        connect: {
          id: userId,
        },
      },
    },
  });
  revalidatePath("/dashboard");
  return createdLink;
};

export const deleteLink = async (id: number) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  // Check if the link exists and belongs to the user
  const link = await prisma.link.findUnique({
    where: {
      id,
    },
  });

  if (!link) {
    return {
      error: "Link not found",
    };
  }

  if (link.userId !== userId) {
    return {
      error: "You are not authorized to delete this link",
    };
  }

  // Delete all the clicks associated with the link
  await prisma.linkVisit.deleteMany({
    where: {
      linkId: id,
    },
  });

  const deletedLink = prisma.link.delete({
    where: {
      id,
    },
  });
  revalidatePath("/dashboard");
  return deletedLink;
};

export const updateLink = async (link: Prisma.LinkUpdateInput, id: number) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  // Check if the link exists and belongs to the user
  const existingLink = await prisma.link.findUnique({
    where: {
      id: id,
    },
  });

  if (!existingLink) {
    return {
      error: "Link not found",
    };
  }

  if (existingLink.userId !== userId) {
    return {
      error: "You are not authorized to update this link",
    };
  }

  const updatedLink = prisma.link.update({
    where: {
      id: id,
    },
    data: {
      ...link,
    },
  });
  revalidatePath("/dashboard");
  return updatedLink;
};

export const disableLink = async (id: number) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  const link = await prisma.link.findUnique({
    where: {
      id,
    },
  });

  if (!link) {
    return {
      error: "Link not found",
    };
  }

  if (link.userId !== userId) {
    return {
      error: "You are not authorized to disable this link",
    };
  }

  const disabledLink = prisma.link.update({
    where: {
      id,
    },
    data: {
      disabled: true,
    },
  });
  revalidatePath("/dashboard");
  return disabledLink;
};

type DynamicLinkCreateInput = Omit<Prisma.DynamicLinkCreateInput, "user">;

export const createDynamicLink = async (link: DynamicLinkCreateInput) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  const createdLink = prisma.dynamicLink.create({
    data: {
      ...link,
      user: {
        connect: {
          id: userId,
        },
      },
    },
  });
  revalidatePath("/dashboard");
  return createdLink;
};

export const validateSubdomainAvailability = async (subdomain: string) => {
  // check if the subdomain is valid
  // check if the subdomain is already taken
  // check if the subdomain is available
  // set formik error if the subdomain is invalid
  // formik.setFieldError("subdomain", "Subdomain is invalid");
  const isLinkThere = await prisma.dynamicLink.findUnique({
    where: {
      subdomain,
    },
  });

  if (isLinkThere) {
    return false;
  }

  return true;
};

type DynamicLinkChildCreateInput = Omit<
  Prisma.DynamicLinkChildLinkCreateInput,
  "user" | "dynamicLink"
>;

export const createDynamicLinkChildLink = async (
  link: DynamicLinkChildCreateInput,
  selectedDynamicLinkProjectID: number,
) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  // check if there is no shortlink entered by the user, then we can generate one
  if (!link.shortLink) {
    link.shortLink = await generateShortLinkForProject(
      link.shortLink,
      selectedDynamicLinkProjectID,
    );
  }

  const createdLink = prisma.dynamicLinkChildLink.create({
    data: {
      ...link,
      dynamicLink: {
        connect: {
          id: selectedDynamicLinkProjectID,
        },
      },
    },
  });
  revalidatePath("/dashboard/links/dynamic");
  return createdLink;
};

export const deleteDynamicLinkChildLink = async (id: number) => {
  const { userId } = auth();

  if (!userId) {
    return;
  }

  // Check if the link exists and belongs to the user
  const link = await prisma.dynamicLinkChildLink.findUnique({
    where: {
      id,
    },
    include: {
      dynamicLink: true,
    },
  });

  if (!link) {
    return {
      error: "Link not found",
    };
  }

  if (link.dynamicLink.userId !== userId) {
    return {
      error: "You are not authorized to delete this link",
    };
  }

  const deletedLink = prisma.dynamicLinkChildLink.delete({
    where: {
      id,
    },
  });
  revalidatePath("/dashboard/links/dynamic");
  return deletedLink;
};
